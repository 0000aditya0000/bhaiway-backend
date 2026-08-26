import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { UsersModule } from '../users/users.module';
import { WalletBalance } from './entities/wallet-balance.entity';
import {
  WalletPointLot,
  WalletPointSource,
} from './entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';
import {
  assertSafeTestDatabaseUrl,
  assertWalletBalanceMatchesLots,
  cleanupTestWallet,
  createTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from './test/wallet-test.helpers';
import { LOT_EXPIRY_IDEMPOTENCY_PREFIX } from './wallet.constants';
import { WalletLotExpiryService } from './wallet-lot-expiry.service';
import { WalletModule } from './wallet.module';
import { WalletService } from './wallet.service';

describe('WalletLotExpiryService', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let expiryService: WalletLotExpiryService;
  let walletService: WalletService;
  const tracked: TestWalletContext[] = [];

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.DATABASE_URL);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env.test' }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: process.env.DATABASE_URL,
          autoLoadEntities: true,
          synchronize: false,
          logging: false,
        }),
        UsersModule,
        WalletModule,
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    expiryService = moduleRef.get(WalletLotExpiryService);
    walletService = moduleRef.get(WalletService);
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await cleanupTestWallet(dataSource, ctx);
      }
    }
  });

  afterAll(async () => {
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  async function spawnWallet() {
    const ctx = await createTestWallet(dataSource);
    tracked.push(ctx);
    return ctx;
  }

  async function creditPromotionalWithExpiry(
    ctx: TestWalletContext,
    amount: bigint,
    expiresAt: Date,
  ) {
    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount,
      sourceType: WalletPointSource.PROMOTIONAL,
      idempotencyKey: uniqueIdempotencyKey('promo-exp'),
    });

    const lot = await dataSource.getRepository(WalletPointLot).findOneOrFail({
      where: { walletId: ctx.walletId },
    });
    await dataSource.getRepository(WalletPointLot).update(lot.id, {
      expiresAt,
    });
    return lot;
  }

  it('expires promotional available amount and reduces balance', async () => {
    const ctx = await spawnWallet();
    await creditPromotionalWithExpiry(
      ctx,
      300n,
      new Date(Date.now() - 60_000),
    );

    const result = await expiryService.expireLotsForWallet(ctx.walletId);
    expect(result.expiredAmount).toBe('300');
    expect(result.expiredLotCount).toBe(1);

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    expect(balance.promotionalAvailable).toBe('0');

    await assertWalletBalanceMatchesLots(dataSource, ctx.walletId);
  });

  it('does not expire future lots', async () => {
    const ctx = await spawnWallet();
    await creditPromotionalWithExpiry(
      ctx,
      200n,
      new Date(Date.now() + 86_400_000),
    );

    const result = await expiryService.expireLotsForWallet(ctx.walletId);
    expect(result.expiredAmount).toBe('0');

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    expect(balance.promotionalAvailable).toBe('200');
  });

  it('does not modify held amounts on expired lots', async () => {
    const ctx = await spawnWallet();
    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount: 500n,
      sourceType: WalletPointSource.PROMOTIONAL,
      idempotencyKey: uniqueIdempotencyKey('held-exp-credit'),
    });

    const lot = await dataSource.getRepository(WalletPointLot).findOneOrFail({
      where: { walletId: ctx.walletId },
    });
    await dataSource.getRepository(WalletPointLot).update(lot.id, {
      expiresAt: new Date(Date.now() - 60_000),
      availableAmount: '200',
      heldAmount: '300',
    });
    await dataSource.getRepository(WalletBalance).update(
      { walletId: ctx.walletId },
      {
        promotionalAvailable: '200',
        promotionalHeld: '300',
      },
    );

    await expiryService.expireLotsForWallet(ctx.walletId);

    const updatedLot = await dataSource
      .getRepository(WalletPointLot)
      .findOneByOrFail({ id: lot.id });
    expect(updatedLot.availableAmount).toBe('0');
    expect(updatedLot.heldAmount).toBe('300');

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    expect(balance.promotionalHeld).toBe('300');
  });

  it('is idempotent per lot', async () => {
    const ctx = await spawnWallet();
    const lot = await creditPromotionalWithExpiry(
      ctx,
      150n,
      new Date(Date.now() - 60_000),
    );

    await expiryService.expireLotsForWallet(ctx.walletId);
    await expiryService.expireLotsForWallet(ctx.walletId);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          walletId: ctx.walletId,
          idempotencyKey: `${LOT_EXPIRY_IDEMPOTENCY_PREFIX}${lot.id}`,
        },
      }),
    ).toBe(1);
  });

  it('creates ADMIN_ADJUSTMENT ledger debit', async () => {
    const ctx = await spawnWallet();
    await creditPromotionalWithExpiry(
      ctx,
      100n,
      new Date(Date.now() - 60_000),
    );

    await expiryService.expireLotsForWallet(ctx.walletId);

    const tx = await dataSource.getRepository(WalletTransaction).findOneOrFail({
      where: {
        walletId: ctx.walletId,
        transactionType: WalletTransactionType.ADMIN_ADJUSTMENT,
      },
    });
    expect(tx.transactionType).toBe(WalletTransactionType.ADMIN_ADJUSTMENT);
    expect(tx.amount).toBe('100');
  });

  it('does not affect driver-earned lots without expiry', async () => {
    const ctx = await spawnWallet();
    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount: 400n,
      sourceType: WalletPointSource.DRIVER_EARNED,
      idempotencyKey: uniqueIdempotencyKey('driver-no-exp'),
    });

    const result = await expiryService.expireLotsForWallet(ctx.walletId);
    expect(result.expiredAmount).toBe('0');

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    expect(balance.driverEarnedAvailable).toBe('400');
  });

  it('concurrent expiry + debit does not corrupt balances', async () => {
    const ctx = await spawnWallet();
    await creditPromotionalWithExpiry(
      ctx,
      500n,
      new Date(Date.now() - 60_000),
    );
    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount: 200n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('race-purch'),
    });

    await Promise.allSettled([
      expiryService.expireLotsForWallet(ctx.walletId),
      walletService.debitPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        idempotencyKey: uniqueIdempotencyKey('race-debit'),
      }),
    ]);

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    for (const field of Object.values(balance)) {
      if (typeof field === 'string' && /^\d+$/.test(field)) {
        expect(BigInt(field)).toBeGreaterThanOrEqual(0n);
      }
    }

    await assertWalletBalanceMatchesLots(dataSource, ctx.walletId);
  });
});
