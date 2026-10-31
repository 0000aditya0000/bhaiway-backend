import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';

import { User, UserStatus } from '../users/entities/user.entity';
import { WalletBalance } from './entities/wallet-balance.entity';
import {
  WalletPointLot,
  WalletPointSource,
} from './entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';
import { Wallet, WalletStatus } from './entities/wallet.entity';
import { WalletOperationConflictError } from './errors/wallet.errors';
import { getExpectedBalanceBucketsFromLots } from './wallet-lot-balance.math';
import {
  PLATFORM_BALANCE_ID,
  PLATFORM_PHONE,
  PLATFORM_SEED_AMOUNT,
  PLATFORM_SEED_IDEMPOTENCY_KEY,
  PLATFORM_SEED_LEDGER_ID,
  PLATFORM_SEED_LOT_ID,
  PLATFORM_USER_ID,
  PLATFORM_USER_ID_SETTING_KEY,
  PLATFORM_WALLET_ID,
  PLATFORM_WALLET_ID_SETTING_KEY,
} from './platform-wallet.constants';

const PLATFORM_EMAIL = 'platform@bhaiway.internal';
const PLATFORM_ENSURE_LOCK_KEY = 'platform-wallet:ensure';

/** Opening float is applied only to a never-used canonical platform wallet. */
export function shouldSeedPlatformOpeningFloat(input: {
  lotCount: number;
  hasOpeningFloatLedger: boolean;
  hasAnyPlatformLedger: boolean;
}): boolean {
  return (
    input.lotCount === 0 &&
    !input.hasOpeningFloatLedger &&
    !input.hasAnyPlatformLedger
  );
}

/**
 * Ensures the canonical platform operating wallet exists.
 *
 * Assured driver cancellation credits PLATFORM_WALLET_ID. That account is
 * seeded by AssuredLifecyclePhase4; if the wallet row exists without a
 * wallet_balances row (or the seed never applied), forfeiture 404s.
 *
 * This recreates only the reserved platform user/wallet/balance. It does not
 * create arbitrary user wallets and does not invent opening float when lots
 * or ledger rows already exist.
 */
@Injectable()
export class PlatformWalletService implements OnModuleInit {
  private readonly logger = new Logger(PlatformWalletService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.ensureInitialized();
  }

  async ensureInitialized(): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // Serializes concurrent process startup. In-transaction repair used by
      // credit/debit does not take this lock (avoids lock-order deadlocks with
      // driver wallet rows) and relies on unique constraints instead.
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        PLATFORM_ENSURE_LOCK_KEY,
      ]);
      await this.ensureInitializedInTransaction(manager);
      await this.ensurePlatformSettings(manager);
    });
  }

  async ensureInitializedInTransaction(manager: EntityManager): Promise<void> {
    await this.ensurePlatformUser(manager);
    await this.ensurePlatformWallet(manager);
    await this.ensurePlatformBalance(manager);
  }

  private async ensurePlatformUser(manager: EntityManager): Promise<User> {
    const users = manager.getRepository(User);
    const existing = await users.findOne({ where: { id: PLATFORM_USER_ID } });
    if (existing) {
      return existing;
    }

    const byPhone = await users.findOne({ where: { phone: PLATFORM_PHONE } });
    if (byPhone) {
      if (byPhone.id !== PLATFORM_USER_ID) {
        throw new WalletOperationConflictError(
          'Platform phone is bound to a non-canonical user',
        );
      }
      return byPhone;
    }

    try {
      return await users.save(
        users.create({
          id: PLATFORM_USER_ID,
          phone: PLATFORM_PHONE,
          phoneVerified: true,
          email: PLATFORM_EMAIL,
          emailVerified: true,
          status: UserStatus.ACTIVE,
        }),
      );
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }
      const raced = await users.findOne({ where: { id: PLATFORM_USER_ID } });
      if (raced) {
        return raced;
      }
      const racedPhone = await users.findOne({
        where: { phone: PLATFORM_PHONE },
      });
      if (racedPhone) {
        if (racedPhone.id !== PLATFORM_USER_ID) {
          throw new WalletOperationConflictError(
            'Platform phone is bound to a non-canonical user',
          );
        }
        return racedPhone;
      }
      throw error;
    }
  }

  private async ensurePlatformWallet(
    manager: EntityManager,
  ): Promise<Wallet> {
    const wallets = manager.getRepository(Wallet);
    const existing = await wallets.findOne({
      where: { id: PLATFORM_WALLET_ID },
    });
    if (existing) {
      if (existing.userId !== PLATFORM_USER_ID) {
        throw new WalletOperationConflictError(
          'Canonical platform wallet is bound to a non-platform user',
        );
      }
      return existing;
    }

    const byUser = await wallets.findOne({
      where: { userId: PLATFORM_USER_ID },
    });
    if (byUser) {
      if (byUser.id !== PLATFORM_WALLET_ID) {
        throw new WalletOperationConflictError(
          'Platform user already has a wallet that is not the canonical platform wallet',
        );
      }
      return byUser;
    }

    try {
      return await wallets.save(
        wallets.create({
          id: PLATFORM_WALLET_ID,
          userId: PLATFORM_USER_ID,
          status: WalletStatus.ACTIVE,
        }),
      );
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }
      const raced = await wallets.findOne({
        where: { id: PLATFORM_WALLET_ID },
      });
      if (raced) {
        if (raced.userId !== PLATFORM_USER_ID) {
          throw new WalletOperationConflictError(
            'Canonical platform wallet is bound to a non-platform user',
          );
        }
        return raced;
      }
      const racedUser = await wallets.findOne({
        where: { userId: PLATFORM_USER_ID },
      });
      if (racedUser) {
        if (racedUser.id !== PLATFORM_WALLET_ID) {
          throw new WalletOperationConflictError(
            'Platform user already has a wallet that is not the canonical platform wallet',
          );
        }
        return racedUser;
      }
      throw error;
    }
  }

  private async ensurePlatformBalance(manager: EntityManager): Promise<void> {
    const balances = manager.getRepository(WalletBalance);
    if (await this.findPlatformBalance(manager)) {
      return;
    }

    const lots = await manager.getRepository(WalletPointLot).find({
      where: { walletId: PLATFORM_WALLET_ID },
    });

    if (lots.length === 0) {
      await this.seedOpeningFloatIfAbsent(manager);
      if (await this.findPlatformBalance(manager)) {
        return;
      }
    }

    const buckets = getExpectedBalanceBucketsFromLots(lots, new Date());
    this.logger.warn(
      'Platform wallet balance row was missing; recreating it from existing lots',
    );
    await this.insertPlatformBalanceIfAbsent(manager, {
      purchasedAvailable: buckets.PURCHASED_AVAILABLE.toString(),
      promotionalAvailable: buckets.PROMOTIONAL_AVAILABLE.toString(),
      driverEarnedAvailable: buckets.DRIVER_EARNED_AVAILABLE.toString(),
      purchasedHeld: buckets.PURCHASED_HELD.toString(),
      promotionalHeld: buckets.PROMOTIONAL_HELD.toString(),
      driverEarnedHeld: buckets.DRIVER_EARNED_HELD.toString(),
    });
  }

  /**
   * Recreates the Phase 4 opening float only when the platform wallet has no
   * lots and no ledger history. Each insert is independently idempotent.
   * Never UPDATEs an existing balance.
   */
  private async seedOpeningFloatIfAbsent(
    manager: EntityManager,
  ): Promise<void> {
    const seedTx = await manager.getRepository(WalletTransaction).findOne({
      where: { idempotencyKey: PLATFORM_SEED_IDEMPOTENCY_KEY },
    });
    const anyTx = await manager.getRepository(WalletTransaction).findOne({
      where: { walletId: PLATFORM_WALLET_ID },
      select: { id: true },
    });
    if (
      !shouldSeedPlatformOpeningFloat({
        lotCount: 0,
        hasOpeningFloatLedger: seedTx != null,
        hasAnyPlatformLedger: anyTx != null,
      })
    ) {
      this.logger.warn(
        'Platform wallet has ledger rows but no lots/balance; materializing a zero balance',
      );
      return;
    }

    this.logger.warn(
      'Platform operating wallet was uninitialized; applying canonical opening float',
    );

    await this.insertPlatformBalanceIfAbsent(manager, {
      purchasedAvailable: PLATFORM_SEED_AMOUNT,
      promotionalAvailable: '0',
      driverEarnedAvailable: '0',
      purchasedHeld: '0',
      promotionalHeld: '0',
      driverEarnedHeld: '0',
    });

    const lots = manager.getRepository(WalletPointLot);
    try {
      await lots.save(
        lots.create({
          id: PLATFORM_SEED_LOT_ID,
          walletId: PLATFORM_WALLET_ID,
          sourceType: WalletPointSource.PURCHASED,
          originalAmount: PLATFORM_SEED_AMOUNT,
          availableAmount: PLATFORM_SEED_AMOUNT,
          heldAmount: '0',
          expiresAt: null,
          referenceType: 'PLATFORM_SEED',
          referenceId: 'platform-operating-float',
        }),
      );
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }
    }

    const transactions = manager.getRepository(WalletTransaction);
    try {
      await transactions.save(
        transactions.create({
          id: PLATFORM_SEED_LEDGER_ID,
          walletId: PLATFORM_WALLET_ID,
          userId: PLATFORM_USER_ID,
          transactionType: WalletTransactionType.PLATFORM_SEED,
          pointSource: WalletPointSource.PURCHASED,
          direction: WalletTransactionDirection.CREDIT,
          amount: PLATFORM_SEED_AMOUNT,
          balanceBefore: '0',
          balanceAfter: PLATFORM_SEED_AMOUNT,
          referenceType: 'PLATFORM_SEED',
          referenceId: 'platform-operating-float',
          parentTransactionId: null,
          idempotencyKey: PLATFORM_SEED_IDEMPOTENCY_KEY,
          status: WalletTransactionStatus.POSTED,
        }),
      );
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }
    }
  }

  private async findPlatformBalance(
    manager: EntityManager,
  ): Promise<WalletBalance | null> {
    return manager.getRepository(WalletBalance).findOne({
      where: { walletId: PLATFORM_WALLET_ID },
    });
  }

  /** Insert-only. Unique(wallet_id) wins races; existing rows are never updated. */
  private async insertPlatformBalanceIfAbsent(
    manager: EntityManager,
    amounts: {
      purchasedAvailable: string;
      promotionalAvailable: string;
      driverEarnedAvailable: string;
      purchasedHeld: string;
      promotionalHeld: string;
      driverEarnedHeld: string;
    },
  ): Promise<void> {
    if (await this.findPlatformBalance(manager)) {
      return;
    }
    const balances = manager.getRepository(WalletBalance);
    try {
      await balances.save(
        balances.create({
          id: PLATFORM_BALANCE_ID,
          walletId: PLATFORM_WALLET_ID,
          ...amounts,
        }),
      );
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }
    }
  }

  private async ensurePlatformSettings(manager: EntityManager): Promise<void> {
    await manager.query(
      `INSERT INTO "app_settings" ("key", "value")
       VALUES ($1, $2), ($3, $4)
       ON CONFLICT ("key") DO NOTHING`,
      [
        PLATFORM_USER_ID_SETTING_KEY,
        PLATFORM_USER_ID,
        PLATFORM_WALLET_ID_SETTING_KEY,
        PLATFORM_WALLET_ID,
      ],
    );
  }

  private isUniqueViolation(error: unknown): boolean {
    let current: unknown = error;
    while (current && typeof current === 'object') {
      const record = current as {
        code?: string;
        driverError?: { code?: string };
        cause?: unknown;
      };
      const code = record.code ?? record.driverError?.code;
      if (code === '23505') {
        return true;
      }
      if (current instanceof QueryFailedError) {
        const driver = current.driverError as { code?: string } | undefined;
        if (driver?.code === '23505') {
          return true;
        }
      }
      current = record.cause ?? record.driverError;
    }
    return false;
  }
}
