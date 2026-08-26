import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { UserProfile } from '../../users/entities/user-profile.entity';
import { WalletBalance } from '../entities/wallet-balance.entity';
import { WalletHoldAllocation } from '../entities/wallet-hold-allocation.entity';
import { WalletHold } from '../entities/wallet-hold.entity';
import {
  WalletPointLot,
  WalletPointSource,
} from '../entities/wallet-point-lot.entity';
import { WalletTransaction } from '../entities/wallet-transaction.entity';
import { Wallet, WalletStatus } from '../entities/wallet.entity';
import {
  reconcileBalanceWithLots,
  sumLotFieldAmounts,
} from '../wallet-lot-balance.math';

export interface TestWalletContext {
  userId: string;
  walletId: string;
  balanceId: string;
  phone: string;
}

export function uniqueIdempotencyKey(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function assertSafeTestDatabaseUrl(databaseUrl: string | undefined): void {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for wallet integration tests');
  }

  if (!databaseUrl.includes('bhaiway_test')) {
    throw new Error(
      'Refusing to run wallet integration tests: DATABASE_URL must target the bhaiway_test database',
    );
  }
}

export async function createTestWallet(
  dataSource: DataSource,
): Promise<TestWalletContext> {
  const userRepository = dataSource.getRepository(User);
  const profileRepository = dataSource.getRepository(UserProfile);
  const walletRepository = dataSource.getRepository(Wallet);
  const balanceRepository = dataSource.getRepository(WalletBalance);

  const phone = `+91${Date.now().toString().slice(-8)}${Math.floor(
    Math.random() * 100,
  )
    .toString()
    .padStart(2, '0')}`;

  const user = await userRepository.save(
    userRepository.create({
      phone,
      phoneVerified: true,
      email: null,
      emailVerified: false,
    }),
  );

  await profileRepository.save(
    profileRepository.create({
      userId: user.id,
      firstName: 'Test',
      lastName: 'Wallet',
      displayName: 'Test Wallet',
      gender: null,
      dateOfBirth: null,
      profilePhoto: null,
    }),
  );

  const wallet = await walletRepository.save(
    walletRepository.create({
      userId: user.id,
      status: WalletStatus.ACTIVE,
    }),
  );

  const balance = await balanceRepository.save(
    balanceRepository.create({
      walletId: wallet.id,
      purchasedAvailable: '0',
      promotionalAvailable: '0',
      driverEarnedAvailable: '0',
      purchasedHeld: '0',
      promotionalHeld: '0',
      driverEarnedHeld: '0',
    }),
  );

  return {
    userId: user.id,
    walletId: wallet.id,
    balanceId: balance.id,
    phone,
  };
}

export async function cleanupTestWallet(
  dataSource: DataSource,
  ctx: TestWalletContext,
): Promise<void> {
  const holdRepository = dataSource.getRepository(WalletHold);
  const allocationRepository = dataSource.getRepository(WalletHoldAllocation);
  const transactionRepository = dataSource.getRepository(WalletTransaction);
  const lotRepository = dataSource.getRepository(WalletPointLot);
  const balanceRepository = dataSource.getRepository(WalletBalance);
  const walletRepository = dataSource.getRepository(Wallet);
  const profileRepository = dataSource.getRepository(UserProfile);
  const userRepository = dataSource.getRepository(User);

  const holds = await holdRepository.find({
    where: { walletId: ctx.walletId },
  });
  const holdIds = holds.map((hold) => hold.id);

  if (holdIds.length > 0) {
    await allocationRepository
      .createQueryBuilder()
      .delete()
      .where('hold_id IN (:...holdIds)', { holdIds })
      .execute();
  }

  await holdRepository.delete({ walletId: ctx.walletId });
  await transactionRepository.delete({ walletId: ctx.walletId });
  await lotRepository.delete({ walletId: ctx.walletId });
  await balanceRepository.delete({ walletId: ctx.walletId });
  await walletRepository.delete({ id: ctx.walletId });
  await profileRepository.delete({ userId: ctx.userId });
  await userRepository.delete({ id: ctx.userId });
}

export async function getBalance(
  repository: Repository<WalletBalance>,
  walletId: string,
): Promise<WalletBalance> {
  const balance = await repository.findOneByOrFail({ walletId });
  return balance;
}

export async function getLots(
  repository: Repository<WalletPointLot>,
  walletId: string,
): Promise<WalletPointLot[]> {
  return repository.find({
    where: { walletId },
    order: { createdAt: 'ASC', id: 'ASC' },
  });
}

export function sumLotAmounts(
  lots: WalletPointLot[],
  sourceType: WalletPointLot['sourceType'],
  field: 'availableAmount' | 'heldAmount',
): bigint {
  return sumLotFieldAmounts(lots, sourceType, field);
}

/** Credit a test wallet so PAY_LATER / Assured fare settlement can succeed at ride completion. */
export async function creditTestWalletPoints(
  walletService: {
    creditPoints(input: {
      walletId: string;
      userId: string;
      amount: bigint;
      sourceType: WalletPointSource;
      idempotencyKey: string;
    }): Promise<unknown>;
  },
  walletId: string,
  userId: string,
  amount: bigint,
  prefix = 'test-fund',
): Promise<void> {
  await walletService.creditPoints({
    walletId,
    userId,
    amount,
    sourceType: WalletPointSource.PURCHASED,
    idempotencyKey: uniqueIdempotencyKey(prefix),
  });
}

/** Assert wallet_balances buckets match spendable lot totals per source. */
export async function assertWalletBalanceMatchesLots(
  dataSource: DataSource,
  walletId: string,
  now: Date = new Date(),
): Promise<void> {
  const balance = await dataSource
    .getRepository(WalletBalance)
    .findOneByOrFail({ walletId });
  const lots = await dataSource.getRepository(WalletPointLot).find({
    where: { walletId },
  });

  const result = reconcileBalanceWithLots(balance, lots, now);
  expect(result.ok).toBe(true);
  expect(result.drift).toEqual([]);
}
