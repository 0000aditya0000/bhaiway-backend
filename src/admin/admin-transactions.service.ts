import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { evaluateAdminReversalEligibility } from '../wallet/admin-transaction-reversal.eligibility';
import {
  AdminReverseTransactionDto,
  AdminTransactionDetailDto,
  AdminTransactionListItemDto,
  AdminTransactionListQueryDto,
  AdminTransactionPageDto,
  AdminReverseTransactionResponseDto,
} from '../wallet/dto/admin-transaction.dto';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import {
  AdminTransactionAlreadyReversedError,
  AdminTransactionNotFoundError,
  AdminTransactionNotReversibleError,
} from '../wallet/errors/admin-transaction.errors';
import { InsufficientWalletBalanceError } from '../wallet/errors/wallet.errors';
import { isPlatformWalletId } from '../wallet/platform-wallet.constants';
import {
  ADMIN_TX_REVERSAL_IDEMPOTENCY_PREFIX,
  ADMIN_TX_REVERSAL_REFERENCE_TYPE,
} from '../wallet/wallet.constants';
import { pointsToCoins } from '../wallet/wallet-coins.mapper';
import { WalletService } from '../wallet/wallet.service';
import {
  AdminAlertCategory,
  AdminAlertSeverity,
} from './entities/admin-alert.entity';
import { AdminActivityEvent } from './entities/admin-activity-event.entity';

@Injectable()
export class AdminTransactionsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly walletService: WalletService,
    @InjectRepository(WalletTransaction)
    private readonly txRepository: Repository<WalletTransaction>,
  ) {}

  async list(
    query: AdminTransactionListQueryDto,
  ): Promise<AdminTransactionPageDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sortBy = query.sortBy ?? 'createdAt';
    const sortOrder = query.sortOrder ?? 'DESC';

    const qb = this.txRepository.createQueryBuilder('tx');

    if (query.status) {
      qb.andWhere('tx.status = :status', { status: query.status });
    }
    if (query.direction) {
      qb.andWhere('tx.direction = :direction', { direction: query.direction });
    }
    if (query.type) {
      qb.andWhere('tx.transaction_type = :type', { type: query.type });
    }
    if (query.from) {
      qb.andWhere('tx.created_at >= :from', {
        from: this.normalizeFrom(query.from),
      });
    }
    if (query.to) {
      qb.andWhere('tx.created_at <= :to', { to: this.normalizeTo(query.to) });
    }
    if (query.search?.trim()) {
      const raw = query.search.trim();
      const uuidLike =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          raw,
        );
      if (uuidLike) {
        qb.andWhere(
          '(tx.id = :searchUuid OR tx.user_id = :searchUuid OR tx.wallet_id = :searchUuid OR tx.reference_id = :searchRaw)',
          { searchUuid: raw, searchRaw: raw },
        );
      } else {
        qb.andWhere(
          '(tx.reference_id ILIKE :searchLike OR tx.idempotency_key ILIKE :searchLike)',
          { searchLike: `%${raw.replace(/[%_]/g, '\\$&')}%` },
        );
      }
    }

    const sortColumn = sortBy === 'amount' ? 'tx.amount' : 'tx.created_at';
    qb.orderBy(sortColumn, sortOrder).addOrderBy('tx.id', sortOrder);
    qb.skip((page - 1) * limit).take(limit);

    const [rows, total] = await qb.getManyAndCount();
    const reversalMap = await this.loadAdminReversalsByParentIds(
      rows.map((r) => r.id),
    );

    return {
      items: rows.map((tx) =>
        this.toListItem(tx, reversalMap.get(tx.id) ?? null),
      ),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async getDetail(transactionId: string): Promise<AdminTransactionDetailDto> {
    const tx = await this.txRepository.findOne({
      where: { id: transactionId },
    });
    if (!tx) {
      throw new AdminTransactionNotFoundError();
    }
    const reversal = await this.findAdminReversal(tx.id);
    return this.toDetail(tx, reversal);
  }

  async reverse(
    transactionId: string,
    adminUserId: string,
    dto: AdminReverseTransactionDto,
  ): Promise<AdminReverseTransactionResponseDto> {
    const reason = dto.reason.trim();
    const idempotencyKey = `${ADMIN_TX_REVERSAL_IDEMPOTENCY_PREFIX}${transactionId}`;

    try {
      return await this.dataSource.transaction(async (manager) => {
        const original = await manager
          .getRepository(WalletTransaction)
          .createQueryBuilder('tx')
          .setLock('pessimistic_write')
          .where('tx.id = :id', { id: transactionId })
          .getOne();

        if (!original) {
          throw new AdminTransactionNotFoundError();
        }

        const existing = await this.findAdminReversalInManager(
          manager,
          original.id,
        );
        const eligibility = evaluateAdminReversalEligibility(
          original,
          existing,
        );
        if (!eligibility.eligible) {
          if (eligibility.reason === 'ALREADY_REVERSED' && existing) {
            return {
              original: this.toDetail(original, existing),
              reversal: this.toDetail(existing, null),
              alreadyReversed: true,
            };
          }
          throw new AdminTransactionNotReversibleError(eligibility.message);
        }

        const amount = BigInt(original.amount);
        const allowPlatform = isPlatformWalletId(original.walletId);

        let compensating: WalletTransaction;
        if (original.direction === WalletTransactionDirection.CREDIT) {
          const result = await this.walletService.debitPointsInTransaction(
            manager,
            {
              walletId: original.walletId,
              userId: original.userId,
              amount,
              referenceType: ADMIN_TX_REVERSAL_REFERENCE_TYPE,
              referenceId: original.id,
              parentTransactionId: original.id,
              idempotencyKey,
              transactionType: WalletTransactionType.ADMIN_ADJUSTMENT,
              allowPlatformOperations: allowPlatform,
            },
          );
          compensating = result.transaction;
        } else {
          const sourceType =
            original.pointSource ?? WalletPointSource.PURCHASED;
          const result = await this.walletService.creditPointsInTransaction(
            manager,
            {
              walletId: original.walletId,
              userId: original.userId,
              amount,
              sourceType,
              referenceType: ADMIN_TX_REVERSAL_REFERENCE_TYPE,
              referenceId: original.id,
              parentTransactionId: original.id,
              idempotencyKey,
              transactionType: WalletTransactionType.ADMIN_ADJUSTMENT,
              allowPlatformOperations: allowPlatform,
              suppressWalletCreditNotification: true,
            },
          );
          compensating = result.transaction;
        }

        await manager.getRepository(AdminActivityEvent).save(
          manager.getRepository(AdminActivityEvent).create({
            eventType: 'ADMIN_TRANSACTION_REVERSED',
            category: AdminAlertCategory.WALLET,
            severity: AdminAlertSeverity.WARNING,
            title: 'Admin transaction reversal',
            description: reason.slice(0, 2000),
            metadata: {
              adminUserId,
              originalTransactionId: original.id,
              reversalTransactionId: compensating.id,
              amount: original.amount,
              direction: original.direction,
              transactionType: original.transactionType,
              reason,
            },
          }),
        );

        return {
          original: this.toDetail(original, compensating),
          reversal: this.toDetail(compensating, null),
          alreadyReversed: false,
        };
      });
    } catch (error) {
      if (
        error instanceof InsufficientWalletBalanceError ||
        error instanceof AdminTransactionNotFoundError ||
        error instanceof AdminTransactionNotReversibleError ||
        error instanceof AdminTransactionAlreadyReversedError
      ) {
        throw error;
      }
      if (this.walletService.isIdempotencyKeyConflict(error)) {
        const existing = await this.findAdminReversal(transactionId);
        const original = await this.txRepository.findOne({
          where: { id: transactionId },
        });
        if (original && existing) {
          return {
            original: this.toDetail(original, existing),
            reversal: this.toDetail(existing, null),
            alreadyReversed: true,
          };
        }
        throw new AdminTransactionAlreadyReversedError();
      }
      throw error;
    }
  }

  private async findAdminReversal(
    originalId: string,
  ): Promise<WalletTransaction | null> {
    return this.txRepository.findOne({
      where: {
        parentTransactionId: originalId,
        referenceType: ADMIN_TX_REVERSAL_REFERENCE_TYPE,
      },
    });
  }

  private async findAdminReversalInManager(
    manager: EntityManager,
    originalId: string,
  ): Promise<WalletTransaction | null> {
    return manager.getRepository(WalletTransaction).findOne({
      where: {
        parentTransactionId: originalId,
        referenceType: ADMIN_TX_REVERSAL_REFERENCE_TYPE,
      },
    });
  }

  private async loadAdminReversalsByParentIds(
    parentIds: string[],
  ): Promise<Map<string, WalletTransaction>> {
    const map = new Map<string, WalletTransaction>();
    if (parentIds.length === 0) {
      return map;
    }
    const rows = await this.txRepository
      .createQueryBuilder('tx')
      .where('tx.parent_transaction_id IN (:...ids)', { ids: parentIds })
      .andWhere('tx.reference_type = :ref', {
        ref: ADMIN_TX_REVERSAL_REFERENCE_TYPE,
      })
      .getMany();
    for (const row of rows) {
      if (row.parentTransactionId) {
        map.set(row.parentTransactionId, row);
      }
    }
    return map;
  }

  private toListItem(
    tx: WalletTransaction,
    reversal: WalletTransaction | null,
  ): AdminTransactionListItemDto {
    return {
      transactionId: tx.id,
      userId: tx.userId,
      walletId: tx.walletId,
      type: tx.transactionType,
      direction: tx.direction,
      amount: pointsToCoins(tx.amount),
      currency: 'INR',
      status: tx.status,
      referenceType: tx.referenceType,
      referenceId: tx.referenceId,
      createdAt: tx.createdAt.toISOString(),
      completedAt: null,
      isReversed: reversal != null,
      reversalTransactionId: reversal?.id ?? null,
    };
  }

  private toDetail(
    tx: WalletTransaction,
    reversal: WalletTransaction | null,
  ): AdminTransactionDetailDto {
    const eligibility = evaluateAdminReversalEligibility(tx, reversal);
    return {
      ...this.toListItem(tx, reversal),
      pointSource: tx.pointSource,
      balanceBefore: pointsToCoins(tx.balanceBefore),
      balanceAfter: pointsToCoins(tx.balanceAfter),
      parentTransactionId: tx.parentTransactionId,
      idempotencyKey: tx.idempotencyKey,
      description: null,
      canReverse: eligibility.eligible,
      reverseBlockReason: eligibility.eligible ? null : eligibility.message,
      reversalTransaction: reversal ? this.toListItem(reversal, null) : null,
    };
  }

  private normalizeFrom(value: string): Date {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return new Date(`${value}T00:00:00.000Z`);
    }
    return new Date(value);
  }

  private normalizeTo(value: string): Date {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return new Date(`${value}T23:59:59.999Z`);
    }
    return new Date(value);
  }
}
