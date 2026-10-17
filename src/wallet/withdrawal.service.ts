import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomInt } from 'crypto';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';

import { NotificationsService } from '../notifications/notifications.service';
import { UserProfile } from '../users/entities/user-profile.entity';
import { loadUserDisplayNamesByUserIds } from '../users/user-display-name.util';
import {
  AdminWithdrawalPageDto,
  AdminWithdrawalResponseDto,
  AdminWithdrawalListQueryDto,
  CreateWithdrawalDto,
  UpdateWithdrawalStatusDto,
  WithdrawalListQueryDto,
  WithdrawalPageDto,
  WithdrawalResponseDto,
  WithdrawalStatusHistoryItemDto,
} from './dto/withdrawal.dto';
import {
  WalletHold,
  WalletHoldStatus,
  WalletHoldType,
} from './entities/wallet-hold.entity';
import { Wallet, WalletStatus } from './entities/wallet.entity';
import { WithdrawalStatusHistory } from './entities/withdrawal-status-history.entity';
import {
  Withdrawal,
  WithdrawalPaymentMethodSnapshot,
} from './entities/withdrawal.entity';
import {
  PaymentMethodType,
  WITHDRAWAL_ALLOWED_TRANSITIONS,
  WITHDRAWAL_CONSUME_IDEMPOTENCY_PREFIX,
  WITHDRAWAL_HOLD_IDEMPOTENCY_PREFIX,
  WITHDRAWAL_REFERENCE_TYPE,
  WITHDRAWAL_RELEASE_IDEMPOTENCY_PREFIX,
  WithdrawalProvider,
  WithdrawalStatus,
} from './enums/withdrawal.enums';
import {
  InsufficientWalletBalanceError,
  WalletHoldAlreadyConsumedError,
  WalletHoldAlreadyReleasedError,
  WalletNotFoundError,
} from './errors/wallet.errors';
import {
  IdempotencyKeyRequiredError,
  InsufficientWithdrawableBalanceError,
  InvalidWithdrawalAmountError,
  InvalidWithdrawalStatusTransitionError,
  PaymentMethodInactiveError,
  WithdrawalAccessDeniedError,
  WithdrawalAlreadyCompletedError,
  WithdrawalIdempotencyConflictError,
  WithdrawalNotFoundError,
} from './errors/withdrawal.errors';
import { PaymentMethodService } from './payment-method.service';
import { maskAccountNumber } from './payment-method-crypto.util';
import { pointsToCoins } from './wallet-coins.mapper';
import { WalletService } from './wallet.service';

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_WITHDRAWAL_COINS = 10_000_000_000n;
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERENCE_RETRIES = 5;

export interface AdminActor {
  /** admin_users.id of the acting administrator. */
  adminUserId: string | null;
}

@Injectable()
export class WithdrawalService {
  private readonly logger = new Logger(WithdrawalService.name);

  private static readonly IDEMPOTENCY_CONSTRAINT =
    'UQ_withdrawals_user_idempotency_key';
  private static readonly REFERENCE_CONSTRAINT = 'UQ_withdrawals_reference_id';

  constructor(
    private readonly dataSource: DataSource,
    private readonly walletService: WalletService,
    private readonly paymentMethodService: PaymentMethodService,
    private readonly notificationsService: NotificationsService,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @InjectRepository(Withdrawal)
    private readonly withdrawalRepository: Repository<Withdrawal>,
    @InjectRepository(WithdrawalStatusHistory)
    private readonly historyRepository: Repository<WithdrawalStatusHistory>,
    @InjectRepository(UserProfile)
    private readonly profileRepository: Repository<UserProfile>,
  ) {}

  // ---------------------------------------------------------------------------
  // User APIs
  // ---------------------------------------------------------------------------

  async createWithdrawal(
    userId: string,
    dto: CreateWithdrawalDto,
    idempotencyKeyRaw: string | undefined,
  ): Promise<WithdrawalResponseDto> {
    const key = this.parseIdempotencyKey(idempotencyKeyRaw);
    const amount = this.parseAmount(dto.amount);
    const amountString = amount.toString();

    const existing = await this.withdrawalRepository.findOne({
      where: { userId, idempotencyKey: key },
    });
    if (existing) {
      this.assertIdempotentMatch(existing, amountString, dto.paymentMethodId);
      return this.toUserResponse(existing);
    }

    for (let attempt = 0; attempt < REFERENCE_RETRIES; attempt += 1) {
      try {
        const created = await this.dataSource.transaction((manager) =>
          this.createWithdrawalInTransaction(
            manager,
            userId,
            dto.paymentMethodId,
            amount,
            key,
          ),
        );
        return this.toUserResponse(created);
      } catch (error) {
        if (
          this.isConstraintViolation(
            error,
            WithdrawalService.IDEMPOTENCY_CONSTRAINT,
          )
        ) {
          const winner = await this.withdrawalRepository.findOne({
            where: { userId, idempotencyKey: key },
          });
          if (winner) {
            this.assertIdempotentMatch(
              winner,
              amountString,
              dto.paymentMethodId,
            );
            return this.toUserResponse(winner);
          }
        }
        if (
          this.isConstraintViolation(
            error,
            WithdrawalService.REFERENCE_CONSTRAINT,
          ) &&
          attempt < REFERENCE_RETRIES - 1
        ) {
          continue;
        }
        throw error;
      }
    }

    throw new Error('Unable to allocate a unique withdrawal reference');
  }

  async listForUser(
    userId: string,
    query: WithdrawalListQueryDto,
  ): Promise<WithdrawalPageDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [rows, total] = await this.withdrawalRepository.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      items: rows.map((row) => this.toUserResponse(row)),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async getForUser(userId: string, id: string): Promise<WithdrawalResponseDto> {
    const withdrawal = await this.withdrawalRepository.findOne({
      where: { id },
    });
    if (!withdrawal) {
      throw new WithdrawalNotFoundError();
    }
    if (withdrawal.userId !== userId) {
      throw new WithdrawalAccessDeniedError();
    }
    return this.toUserResponse(withdrawal);
  }

  // ---------------------------------------------------------------------------
  // Admin APIs
  // ---------------------------------------------------------------------------

  async listForAdmin(
    query: AdminWithdrawalListQueryDto,
  ): Promise<AdminWithdrawalPageDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [rows, total] = await this.withdrawalRepository.findAndCount({
      where: query.status ? { status: query.status } : {},
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const nameMap = await loadUserDisplayNamesByUserIds(
      this.profileRepository,
      rows.map((row) => row.userId),
    );

    return {
      items: rows.map((row) =>
        this.toAdminResponse(row, nameMap.get(row.userId) ?? null),
      ),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async getForAdmin(id: string): Promise<AdminWithdrawalResponseDto> {
    const withdrawal = await this.withdrawalRepository.findOne({
      where: { id },
    });
    if (!withdrawal) {
      throw new WithdrawalNotFoundError();
    }
    return this.toAdminDetail(withdrawal);
  }

  async updateStatus(
    actor: AdminActor,
    id: string,
    dto: UpdateWithdrawalStatusDto,
  ): Promise<AdminWithdrawalResponseDto> {
    const updated = await this.dataSource.transaction(async (manager) => {
      const withdrawal = await manager
        .getRepository(Withdrawal)
        .createQueryBuilder('w')
        .setLock('pessimistic_write')
        .where('w.id = :id', { id })
        .getOne();
      if (!withdrawal) {
        throw new WithdrawalNotFoundError();
      }

      const from = withdrawal.status;
      const to = dto.status;

      if (
        from === WithdrawalStatus.COMPLETED &&
        to === WithdrawalStatus.COMPLETED
      ) {
        throw new WithdrawalAlreadyCompletedError();
      }
      if (!WITHDRAWAL_ALLOWED_TRANSITIONS[from].includes(to)) {
        throw new InvalidWithdrawalStatusTransitionError(from, to);
      }

      const now = new Date();
      const remarks = dto.remarks?.trim() ? dto.remarks.trim() : null;

      switch (to) {
        case WithdrawalStatus.PROCESSING:
          withdrawal.processedAt = now;
          break;
        case WithdrawalStatus.COMPLETED:
          await this.consumeWithdrawalHold(manager, withdrawal);
          withdrawal.completedAt = now;
          break;
        case WithdrawalStatus.FAILED:
        case WithdrawalStatus.CANCELLED:
          await this.releaseWithdrawalHold(manager, withdrawal, to);
          break;
        default:
          throw new InvalidWithdrawalStatusTransitionError(from, to);
      }

      withdrawal.status = to;
      if (remarks !== null) {
        withdrawal.adminRemarks = remarks;
      }
      await manager.save(Withdrawal, withdrawal);

      await manager.save(
        WithdrawalStatusHistory,
        manager.create(WithdrawalStatusHistory, {
          withdrawalId: withdrawal.id,
          previousStatus: from,
          newStatus: to,
          adminUserId: actor.adminUserId,
          remarks,
        }),
      );

      return withdrawal;
    });

    if (updated.status === WithdrawalStatus.PROCESSING) {
      await this.notificationsService.safeNotifyWithdrawalProcessing({
        userId: updated.userId,
        withdrawalId: updated.id,
        referenceId: updated.referenceId,
        amount: updated.amount,
      });
    } else if (updated.status === WithdrawalStatus.COMPLETED) {
      await this.notificationsService.safeNotifyWithdrawalCompleted({
        userId: updated.userId,
        withdrawalId: updated.id,
        referenceId: updated.referenceId,
        amount: updated.amount,
      });
    }

    return this.toAdminDetail(updated);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async createWithdrawalInTransaction(
    manager: EntityManager,
    userId: string,
    paymentMethodId: string,
    amount: bigint,
    key: string,
  ): Promise<Withdrawal> {
    const amountString = amount.toString();

    const existing = await manager.findOne(Withdrawal, {
      where: { userId, idempotencyKey: key },
    });
    if (existing) {
      this.assertIdempotentMatch(existing, amountString, paymentMethodId);
      return existing;
    }

    const wallet = await manager.findOne(Wallet, { where: { userId } });
    if (!wallet) {
      throw new WalletNotFoundError();
    }
    if (wallet.status !== WalletStatus.ACTIVE) {
      throw new ForbiddenException(
        wallet.status === WalletStatus.LOCKED
          ? 'Wallet is locked'
          : 'Wallet is suspended',
      );
    }

    const method = await this.paymentMethodService.findOwned(
      userId,
      paymentMethodId,
      manager,
    );
    if (!method.isActive) {
      throw new PaymentMethodInactiveError();
    }

    const snapshot = this.paymentMethodService.buildSnapshot(method);

    const withdrawal = await manager.save(
      Withdrawal,
      manager.create(Withdrawal, {
        userId,
        walletId: wallet.id,
        amount: amountString,
        status: WithdrawalStatus.INITIATED,
        provider: WithdrawalProvider.MANUAL,
        paymentMethodId: method.id,
        paymentMethodType: method.type,
        paymentMethodSnapshot: snapshot,
        walletHoldId: null,
        walletTransactionId: null,
        referenceId: this.generateReferenceId(),
        idempotencyKey: key,
        adminRemarks: null,
        processedAt: null,
        completedAt: null,
      }),
    );

    let holdResult;
    try {
      holdResult = await this.walletService.createHoldInTransaction(manager, {
        walletId: wallet.id,
        amount,
        holdType: WalletHoldType.WITHDRAWAL,
        referenceType: WITHDRAWAL_REFERENCE_TYPE,
        referenceId: withdrawal.id,
        // User-scoped so another user's identical client key can never alias this hold.
        idempotencyKey: `${WITHDRAWAL_HOLD_IDEMPOTENCY_PREFIX}${userId}:${key}`,
      });
    } catch (error) {
      if (error instanceof InsufficientWalletBalanceError) {
        throw new InsufficientWithdrawableBalanceError();
      }
      throw error;
    }

    withdrawal.walletHoldId = holdResult.hold?.id ?? null;
    withdrawal.walletTransactionId = holdResult.transaction.id;
    if (!withdrawal.walletHoldId) {
      throw new Error('Withdrawal hold was not created');
    }
    await manager.save(Withdrawal, withdrawal);

    await this.notificationsService.safeNotifyWithdrawalInitiatedInTransaction(
      manager,
      {
        userId,
        withdrawalId: withdrawal.id,
        referenceId: withdrawal.referenceId,
        amount: withdrawal.amount,
      },
    );

    return withdrawal;
  }

  private async consumeWithdrawalHold(
    manager: EntityManager,
    withdrawal: Withdrawal,
  ): Promise<void> {
    if (!withdrawal.walletHoldId) {
      throw new Error(`Withdrawal ${withdrawal.id} has no wallet hold`);
    }
    try {
      await this.walletService.consumeHoldInTransaction(manager, {
        holdId: withdrawal.walletHoldId,
        idempotencyKey: `${WITHDRAWAL_CONSUME_IDEMPOTENCY_PREFIX}${withdrawal.id}`,
      });
    } catch (error) {
      // Hold already consumed → idempotent success handled inside WalletService;
      // a released hold means funds were already returned and cannot be paid out.
      if (error instanceof WalletHoldAlreadyReleasedError) {
        throw new InvalidWithdrawalStatusTransitionError(
          withdrawal.status,
          WithdrawalStatus.COMPLETED,
        );
      }
      throw error;
    }
  }

  private async releaseWithdrawalHold(
    manager: EntityManager,
    withdrawal: Withdrawal,
    status: WithdrawalStatus.FAILED | WithdrawalStatus.CANCELLED,
  ): Promise<void> {
    if (!withdrawal.walletHoldId) {
      throw new Error(`Withdrawal ${withdrawal.id} has no wallet hold`);
    }

    const hold = await manager.findOne(WalletHold, {
      where: { id: withdrawal.walletHoldId },
    });
    if (hold?.status === WalletHoldStatus.RELEASED) {
      return; // already released → idempotent success
    }

    try {
      await this.walletService.releaseHoldInTransaction(manager, {
        holdId: withdrawal.walletHoldId,
        idempotencyKey: `${WITHDRAWAL_RELEASE_IDEMPOTENCY_PREFIX}${withdrawal.id}:${status}`,
      });
    } catch (error) {
      if (error instanceof WalletHoldAlreadyConsumedError) {
        throw new WithdrawalAlreadyCompletedError();
      }
      throw error;
    }
  }

  private parseIdempotencyKey(raw: string | undefined): string {
    const key = raw?.trim();
    if (!key) {
      throw new IdempotencyKeyRequiredError();
    }
    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new IdempotencyKeyRequiredError(
        `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      );
    }
    return key;
  }

  private parseAmount(raw: number | string): bigint {
    let value: bigint;
    if (typeof raw === 'number') {
      if (!Number.isSafeInteger(raw) || raw <= 0) {
        throw new InvalidWithdrawalAmountError();
      }
      value = BigInt(raw);
    } else if (typeof raw === 'string') {
      if (!/^[1-9]\d{0,15}$/.test(raw)) {
        throw new InvalidWithdrawalAmountError();
      }
      value = BigInt(raw);
    } else {
      throw new InvalidWithdrawalAmountError();
    }

    if (value <= 0n || value > MAX_WITHDRAWAL_COINS) {
      throw new InvalidWithdrawalAmountError();
    }
    return value;
  }

  private assertIdempotentMatch(
    existing: Withdrawal,
    amount: string,
    paymentMethodId: string,
  ): void {
    if (
      existing.amount !== amount ||
      (existing.paymentMethodId !== null &&
        existing.paymentMethodId !== paymentMethodId)
    ) {
      throw new WithdrawalIdempotencyConflictError();
    }
  }

  private generateReferenceId(): string {
    let suffix = '';
    for (let i = 0; i < 8; i += 1) {
      suffix += REFERENCE_ALPHABET[randomInt(0, REFERENCE_ALPHABET.length)];
    }
    return `WD-${suffix}`;
  }

  private isConstraintViolation(
    error: unknown,
    constraintName: string,
  ): boolean {
    let current: unknown = error;
    while (current && typeof current === 'object') {
      const record = current as {
        code?: string;
        constraint?: string;
        driverError?: { code?: string; constraint?: string };
        cause?: unknown;
      };
      const code = record.code ?? record.driverError?.code;
      const constraint = record.constraint ?? record.driverError?.constraint;
      if (code === '23505' && constraint === constraintName) {
        return true;
      }
      if (current instanceof QueryFailedError) {
        const driver = current.driverError as
          { code?: string; constraint?: string } | undefined;
        if (driver?.code === '23505' && driver.constraint === constraintName) {
          return true;
        }
      }
      current = record.cause;
    }
    return false;
  }

  private toPaymentMethodView(snapshot: WithdrawalPaymentMethodSnapshot) {
    return {
      type: snapshot.type,
      upiId: snapshot.upiId ?? null,
      accountHolderName: snapshot.accountHolderName ?? null,
      accountNumberMasked:
        snapshot.type === PaymentMethodType.BANK_ACCOUNT
          ? maskAccountNumber(snapshot.accountNumberLast4)
          : null,
      ifscCode: snapshot.ifscCode ?? null,
      bankName: snapshot.bankName ?? null,
    };
  }

  private toUserResponse(w: Withdrawal): WithdrawalResponseDto {
    return {
      id: w.id,
      referenceId: w.referenceId,
      amount: pointsToCoins(w.amount),
      status: w.status,
      provider: w.provider,
      paymentMethodId: w.paymentMethodId,
      paymentMethodType: w.paymentMethodType,
      paymentMethod: this.toPaymentMethodView(w.paymentMethodSnapshot),
      adminRemarks: w.adminRemarks,
      processedAt: w.processedAt ? w.processedAt.toISOString() : null,
      completedAt: w.completedAt ? w.completedAt.toISOString() : null,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    };
  }

  private toAdminResponse(
    w: Withdrawal,
    userName: string | null,
  ): AdminWithdrawalResponseDto {
    return {
      ...this.toUserResponse(w),
      userId: w.userId,
      userName,
      walletId: w.walletId,
      walletHoldId: w.walletHoldId,
      walletTransactionId: w.walletTransactionId,
    };
  }

  private async toAdminDetail(
    w: Withdrawal,
  ): Promise<AdminWithdrawalResponseDto> {
    const history = await this.historyRepository.find({
      where: { withdrawalId: w.id },
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    const statusHistory: WithdrawalStatusHistoryItemDto[] = history.map(
      (row) => ({
        id: row.id,
        previousStatus: row.previousStatus,
        newStatus: row.newStatus,
        adminUserId: row.adminUserId,
        remarks: row.remarks,
        createdAt: row.createdAt.toISOString(),
      }),
    );

    const nameMap = await loadUserDisplayNamesByUserIds(
      this.profileRepository,
      [w.userId],
    );

    return {
      ...this.toAdminResponse(w, nameMap.get(w.userId) ?? null),
      payoutAccountNumber:
        w.paymentMethodType === PaymentMethodType.BANK_ACCOUNT
          ? this.paymentMethodService.decryptSnapshotAccountNumber(
              w.paymentMethodSnapshot,
            )
          : null,
      statusHistory,
    };
  }
}
