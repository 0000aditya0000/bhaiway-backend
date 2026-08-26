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
import { WalletTransaction } from './entities/wallet-transaction.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  createTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from './test/wallet-test.helpers';
import { WalletModule } from './wallet.module';
import { WalletReconciliationService } from './wallet-reconciliation.service';
import { WalletService } from './wallet.service';

describe('WalletReconciliationService', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let reconciliationService: WalletReconciliationService;
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
    reconciliationService = moduleRef.get(WalletReconciliationService);
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

  it('reports ok for matching wallet with multiple lots', async () => {
    const ctx = await spawnWallet();

    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount: 500n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('rec-purch'),
    });
    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount: 200n,
      sourceType: WalletPointSource.PROMOTIONAL,
      idempotencyKey: uniqueIdempotencyKey('rec-promo'),
    });
    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount: 100n,
      sourceType: WalletPointSource.DRIVER_EARNED,
      idempotencyKey: uniqueIdempotencyKey('rec-driver'),
    });

    const result = await reconciliationService.reconcileWallet(ctx.walletId);
    expect(result.ok).toBe(true);
    expect(result.drift).toEqual([]);
  });

  it('detects purchased available drift', async () => {
    const ctx = await spawnWallet();
    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount: 500n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('drift-purch'),
    });

    await dataSource.getRepository(WalletBalance).update(
      { walletId: ctx.walletId },
      { purchasedAvailable: '999' },
    );

    const result = await reconciliationService.reconcileWallet(ctx.walletId);
    expect(result.ok).toBe(false);
    expect(result.drift).toContainEqual({
      bucket: 'PURCHASED_AVAILABLE',
      expected: '500',
      actual: '999',
    });
  });

  it('detects promotional and driver-earned drift', async () => {
    const ctx = await spawnWallet();
    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount: 200n,
      sourceType: WalletPointSource.PROMOTIONAL,
      idempotencyKey: uniqueIdempotencyKey('drift-promo'),
    });
    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount: 100n,
      sourceType: WalletPointSource.DRIVER_EARNED,
      idempotencyKey: uniqueIdempotencyKey('drift-driver'),
    });

    await dataSource.getRepository(WalletBalance).update(
      { walletId: ctx.walletId },
      {
        promotionalAvailable: '250',
        driverEarnedAvailable: '50',
      },
    );

    const result = await reconciliationService.reconcileWallet(ctx.walletId);
    expect(result.drift.map((item) => item.bucket)).toEqual(
      expect.arrayContaining([
        'PROMOTIONAL_AVAILABLE',
        'DRIVER_EARNED_AVAILABLE',
      ]),
    );
  });

  it('detects held drift', async () => {
    const ctx = await spawnWallet();
    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount: 500n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('drift-held-credit'),
    });
    await dataSource.getRepository(WalletBalance).update(
      { walletId: ctx.walletId },
      { purchasedHeld: '100' },
    );

    const result = await reconciliationService.reconcileWallet(ctx.walletId);
    expect(result.drift).toContainEqual({
      bucket: 'PURCHASED_HELD',
      expected: '0',
      actual: '100',
    });
  });

  it('treats expired lot available as non-spendable expected balance', async () => {
    const ctx = await spawnWallet();
    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount: 300n,
      sourceType: WalletPointSource.PROMOTIONAL,
      idempotencyKey: uniqueIdempotencyKey('expired-lot'),
    });

    const lot = await dataSource.getRepository(WalletPointLot).findOneOrFail({
      where: { walletId: ctx.walletId },
    });
    await dataSource.getRepository(WalletPointLot).update(lot.id, {
      expiresAt: new Date(Date.now() - 60_000),
    });

    const now = new Date();
    const result = await reconciliationService.reconcileWallet(ctx.walletId, now);
    expect(result.drift).toContainEqual({
      bucket: 'PROMOTIONAL_AVAILABLE',
      expected: '0',
      actual: '300',
    });
  });

  it('reports ok for zero balance wallet', async () => {
    const ctx = await spawnWallet();
    const result = await reconciliationService.reconcileWallet(ctx.walletId);
    expect(result.ok).toBe(true);
  });

  it('does not mutate wallet state during reconciliation', async () => {
    const ctx = await spawnWallet();
    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount: 100n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('no-mut'),
    });

    const balanceBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    const txCountBefore = await dataSource
      .getRepository(WalletTransaction)
      .count({ where: { walletId: ctx.walletId } });

    await reconciliationService.reconcileWallet(ctx.walletId);

    const balanceAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    const txCountAfter = await dataSource
      .getRepository(WalletTransaction)
      .count({ where: { walletId: ctx.walletId } });

    expect(balanceAfter).toEqual(balanceBefore);
    expect(txCountAfter).toBe(txCountBefore);
  });
});
