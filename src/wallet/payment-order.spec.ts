import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';

import { UsersModule } from '../users/users.module';
import { PaymentOrder } from './entities/payment-order.entity';
import {
  PaymentOrderProvider,
  PaymentOrderStatus,
} from './enums/payment-order.enums';
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  createTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from './test/wallet-test.helpers';
import { WalletModule } from './wallet.module';

describe('PaymentOrder foundation (Phase 1)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let paymentOrderRepository: Repository<PaymentOrder>;
  const tracked: TestWalletContext[] = [];

  async function spawnWallet(): Promise<TestWalletContext> {
    const ctx = await createTestWallet(dataSource);
    tracked.push(ctx);
    return ctx;
  }

  function buildOrder(
    ctx: TestWalletContext,
    overrides: Partial<PaymentOrder> = {},
  ): PaymentOrder {
    return paymentOrderRepository.create({
      userId: ctx.userId,
      walletId: ctx.walletId,
      amount: '500',
      currency: 'INR',
      provider: PaymentOrderProvider.MOCK,
      status: PaymentOrderStatus.PENDING,
      gatewayOrderId: null,
      idempotencyKey: null,
      walletTransactionId: null,
      callbackReference: null,
      ...overrides,
    });
  }

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
    paymentOrderRepository = dataSource.getRepository(PaymentOrder);

    const tableExists = await dataSource.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'payment_orders'
      ) AS exists
    `);
    if (!tableExists[0]?.exists) {
      throw new Error(
        'payment_orders table missing — run migration 1786566000000-WalletTopUpOrders before tests',
      );
    }
  }, 30_000);

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await dataSource.getRepository(PaymentOrder).delete({
          userId: ctx.userId,
        });
        await cleanupTestWallet(dataSource, ctx);
      }
    }
  });

  afterAll(async () => {
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  it('A: PaymentOrder entity is registered in WalletModule', () => {
    expect(paymentOrderRepository).toBeDefined();
    expect(paymentOrderRepository.metadata.tableName).toBe('payment_orders');
  });

  it('B: payment_orders table exists with expected columns', async () => {
    const columns = await dataSource.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'payment_orders'
      ORDER BY column_name
    `);
    const names = columns.map((row: { column_name: string }) => row.column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'amount',
        'callback_reference',
        'created_at',
        'currency',
        'gateway_order_id',
        'id',
        'idempotency_key',
        'provider',
        'status',
        'updated_at',
        'user_id',
        'wallet_id',
        'wallet_transaction_id',
      ]),
    );
  });

  it('G: valid order can be created with MOCK, PENDING, INR', async () => {
    const ctx = await spawnWallet();
    const saved = await paymentOrderRepository.save(
      buildOrder(ctx, { idempotencyKey: uniqueIdempotencyKey('po-valid') }),
    );

    expect(saved.provider).toBe(PaymentOrderProvider.MOCK);
    expect(saved.status).toBe(PaymentOrderStatus.PENDING);
    expect(saved.currency).toBe('INR');
    expect(saved.amount).toBe('500');
    expect(saved.gatewayOrderId).toBeNull();
    expect(saved.walletTransactionId).toBeNull();
  });

  it('C: amount must be greater than zero', async () => {
    const ctx = await spawnWallet();
    await expect(
      paymentOrderRepository.save(buildOrder(ctx, { amount: '0' })),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('D: gateway_order_id must be unique when provided', async () => {
    const ctx = await spawnWallet();
    const gatewayOrderId = `mock-gw-${Date.now()}`;
    await paymentOrderRepository.save(
      buildOrder(ctx, { gatewayOrderId }),
    );
    await expect(
      paymentOrderRepository.save(
        buildOrder(ctx, { gatewayOrderId }),
      ),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('E: idempotency_key must be unique when provided', async () => {
    const ctx = await spawnWallet();
    const key = uniqueIdempotencyKey('po-idem');
    await paymentOrderRepository.save(buildOrder(ctx, { idempotencyKey: key }));
    await expect(
      paymentOrderRepository.save(buildOrder(ctx, { idempotencyKey: key })),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('F: multiple NULL idempotency keys are allowed', async () => {
    const ctx = await spawnWallet();
    const first = await paymentOrderRepository.save(buildOrder(ctx));
    const second = await paymentOrderRepository.save(buildOrder(ctx));
    expect(first.idempotencyKey).toBeNull();
    expect(second.idempotencyKey).toBeNull();
    expect(first.id).not.toBe(second.id);
  });

  it('H: rejects invalid user_id foreign key', async () => {
    const ctx = await spawnWallet();
    await expect(
      paymentOrderRepository.save(
        buildOrder(ctx, {
          userId: '00000000-0000-0000-0000-000000000099',
        }),
      ),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('H: rejects invalid wallet_id foreign key', async () => {
    const ctx = await spawnWallet();
    await expect(
      paymentOrderRepository.save(
        buildOrder(ctx, {
          walletId: '00000000-0000-0000-0000-000000000099',
        }),
      ),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('H: rejects invalid wallet_transaction_id foreign key', async () => {
    const ctx = await spawnWallet();
    await expect(
      paymentOrderRepository.save(
        buildOrder(ctx, {
          walletTransactionId: '00000000-0000-0000-0000-000000000099',
        }),
      ),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('I: deleting a user referenced by payment_orders is blocked', async () => {
    const ctx = await spawnWallet();
    await paymentOrderRepository.save(buildOrder(ctx));

    await expect(
      dataSource.query(`DELETE FROM users WHERE id = $1`, [ctx.userId]),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('I: deleting a wallet referenced by payment_orders is blocked', async () => {
    const ctx = await spawnWallet();
    await paymentOrderRepository.save(buildOrder(ctx));

    await expect(
      dataSource.query(`DELETE FROM wallets WHERE id = $1`, [ctx.walletId]),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('I: deleting a wallet_transaction referenced by payment_orders is blocked', async () => {
    const ctx = await spawnWallet();
    const tx = await dataSource.getRepository(WalletTransaction).save(
      dataSource.getRepository(WalletTransaction).create({
        walletId: ctx.walletId,
        userId: ctx.userId,
        transactionType: WalletTransactionType.POINT_PURCHASE,
        pointSource: null,
        direction: WalletTransactionDirection.CREDIT,
        amount: '100',
        balanceBefore: '0',
        balanceAfter: '100',
        idempotencyKey: uniqueIdempotencyKey('po-tx-fk'),
        status: WalletTransactionStatus.POSTED,
      }),
    );

    await paymentOrderRepository.save(
      buildOrder(ctx, { walletTransactionId: tx.id }),
    );

    await expect(
      dataSource.query(`DELETE FROM wallet_transactions WHERE id = $1`, [
        tx.id,
      ]),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });
});
