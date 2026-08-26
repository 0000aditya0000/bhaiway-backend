import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { WalletBalance } from './entities/wallet-balance.entity';
import { WalletPointLot } from './entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';
import { Wallet } from './entities/wallet.entity';
import { WalletBalanceNotFoundError } from './errors/wallet.errors';
import {
  decreaseAvailableBalance,
  getTotalWalletBalance,
} from './wallet-lot-balance.math';
import {
  LOT_EXPIRY_IDEMPOTENCY_PREFIX,
  LOT_EXPIRY_REFERENCE_TYPE,
} from './wallet.constants';

export interface ExpireLotsResult {
  walletId: string;
  expiredLotCount: number;
  expiredAmount: string;
  transactionIds: string[];
}

/**
 * Materializes promotional (and other expiring) lot expiry into wallet_balances.
 *
 * Accounting note: uses existing ADMIN_ADJUSTMENT ledger type with referenceType
 * LOT_EXPIRY. No new transaction enum was added. Held amounts on expired lots are
 * preserved until hold release/consume flows run.
 */
@Injectable()
export class WalletLotExpiryService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
  ) {}

  async expireLotsForWallet(
    walletId: string,
    now: Date = new Date(),
  ): Promise<ExpireLotsResult> {
    const wallet = await this.walletRepository.findOne({
      where: { id: walletId },
    });
    if (!wallet) {
      return {
        walletId,
        expiredLotCount: 0,
        expiredAmount: '0',
        transactionIds: [],
      };
    }

    return this.dataSource.transaction(async (manager) =>
      this.expireLotsInTransaction(manager, walletId, wallet.userId, now),
    );
  }

  async expireLotsInTransaction(
    manager: EntityManager,
    walletId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<ExpireLotsResult> {
    const balance = await this.lockWalletBalance(manager, walletId);
    const expiredLots = await manager
      .getRepository(WalletPointLot)
      .createQueryBuilder('lot')
      .setLock('pessimistic_write')
      .where('lot.wallet_id = :walletId', { walletId })
      .andWhere('lot.available_amount > 0')
      .andWhere('lot.expires_at IS NOT NULL')
      .andWhere('lot.expires_at <= :now', { now })
      .orderBy('lot.id', 'ASC')
      .getMany();

    let expiredAmount = 0n;
    const transactionIds: string[] = [];

    for (const lot of expiredLots) {
      const amount = BigInt(lot.availableAmount);
      if (amount <= 0n) {
        continue;
      }

      const idempotencyKey = `${LOT_EXPIRY_IDEMPOTENCY_PREFIX}${lot.id}`;
      const existing = await manager.findOne(WalletTransaction, {
        where: { idempotencyKey },
      });
      if (existing) {
        transactionIds.push(existing.id);
        continue;
      }

      const balanceBefore = getTotalWalletBalance(balance);
      decreaseAvailableBalance(balance, lot.sourceType, amount);
      lot.availableAmount = '0';
      const balanceAfter = getTotalWalletBalance(balance);

      const transaction = manager.create(WalletTransaction, {
        walletId,
        userId,
        transactionType: WalletTransactionType.ADMIN_ADJUSTMENT,
        pointSource: lot.sourceType,
        direction: WalletTransactionDirection.DEBIT,
        amount: amount.toString(),
        balanceBefore: balanceBefore.toString(),
        balanceAfter: balanceAfter.toString(),
        referenceType: LOT_EXPIRY_REFERENCE_TYPE,
        referenceId: lot.id,
        parentTransactionId: null,
        idempotencyKey,
        status: WalletTransactionStatus.POSTED,
      });

      await manager.save(WalletPointLot, lot);
      const savedTx = await manager.save(WalletTransaction, transaction);
      transactionIds.push(savedTx.id);
      expiredAmount += amount;
    }

    if (expiredLots.length > 0) {
      await manager.save(WalletBalance, balance);
    }

    return {
      walletId,
      expiredLotCount: transactionIds.length,
      expiredAmount: expiredAmount.toString(),
      transactionIds,
    };
  }

  private async lockWalletBalance(
    manager: EntityManager,
    walletId: string,
  ): Promise<WalletBalance> {
    const balance = await manager
      .getRepository(WalletBalance)
      .createQueryBuilder('balance')
      .setLock('pessimistic_write')
      .where('balance.wallet_id = :walletId', { walletId })
      .getOne();

    if (!balance) {
      throw new WalletBalanceNotFoundError(walletId);
    }

    return balance;
  }
}
