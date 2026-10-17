/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { UsersModule } from '../users/users.module';
import { WalletHoldType } from '../wallet/entities/wallet-hold.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  createTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import {
  ADMIN_PERMISSION_TRANSACTIONS_REVERSE,
  ADMIN_PERMISSION_TRANSACTIONS_VIEW,
} from './admin.constants';
import { AdminModule } from './admin.module';
import { AdminUser } from './entities/admin-user.entity';

describe('Admin Transactions API (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let walletService: WalletService;
  const tracked: TestWalletContext[] = [];

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.DATABASE_URL);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env.test',
        }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: process.env.DATABASE_URL,
          autoLoadEntities: true,
          synchronize: false,
          logging: false,
        }),
        AuthModule,
        UsersModule,
        WalletModule,
        AdminModule,
      ],
    })
      .overrideProvider(OTP_PROVIDER)
      .useValue({
        verifyAccessToken: jest
          .fn()
          .mockRejectedValue(new Msg91ResponseFormatError()),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    dataSource = moduleRef.get(DataSource);
    authService = moduleRef.get(AuthService);
    walletService = moduleRef.get(WalletService);
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (!ctx) continue;
      await dataSource.getRepository(AdminUser).delete({ userId: ctx.userId });
      await cleanupTestWallet(dataSource, ctx);
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  async function trackUser(): Promise<TestWalletContext> {
    const ctx = await createTestWallet(dataSource);
    tracked.push(ctx);
    return ctx;
  }

  async function login(userId: string): Promise<string> {
    return authService.signAccessToken(userId);
  }

  async function ensureAdmin(
    userId: string,
    permissions: string[],
  ): Promise<void> {
    const repo = dataSource.getRepository(AdminUser);
    let admin = await repo.findOne({ where: { userId } });
    if (!admin) {
      admin = repo.create({
        userId,
        username: `tx_admin_${userId.slice(0, 8)}`,
        passwordHash: 'x',
        permissions,
        isActive: true,
      });
    } else {
      admin.permissions = permissions;
      admin.isActive = true;
    }
    await repo.save(admin);
  }

  it('rejects non-admin and view-only cannot reverse', async () => {
    const user = await trackUser();
    const token = await login(user.userId);
    await request(app.getHttpServer())
      .get('/admin/transactions')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    await ensureAdmin(user.userId, [ADMIN_PERMISSION_TRANSACTIONS_VIEW]);
    const viewToken = await login(user.userId);
    await request(app.getHttpServer())
      .get('/admin/transactions')
      .set('Authorization', `Bearer ${viewToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/admin/transactions/${randomUUID()}/reverse`)
      .set('Authorization', `Bearer ${viewToken}`)
      .send({ reason: 'test reverse attempt' })
      .expect(403);
  });

  it('lists, filters, paginates, and returns detail', async () => {
    const admin = await trackUser();
    const driver = await trackUser();
    await ensureAdmin(admin.userId, [
      ADMIN_PERMISSION_TRANSACTIONS_VIEW,
      ADMIN_PERMISSION_TRANSACTIONS_REVERSE,
    ]);
    const token = await login(admin.userId);

    await walletService.creditPoints({
      walletId: driver.walletId,
      userId: driver.userId,
      amount: 100n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('admin-tx-list-a'),
      referenceType: 'TEST',
      referenceId: 'ref-list-a',
    });
    await walletService.creditPoints({
      walletId: driver.walletId,
      userId: driver.userId,
      amount: 50n,
      sourceType: WalletPointSource.PROMOTIONAL,
      idempotencyKey: uniqueIdempotencyKey('admin-tx-list-b'),
      transactionType: WalletTransactionType.PROMOTIONAL_CREDIT,
    });

    const page = await request(app.getHttpServer())
      .get('/admin/transactions')
      .query({
        page: 1,
        limit: 10,
        search: driver.userId,
        direction: WalletTransactionDirection.CREDIT,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
      })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(page.body.total).toBeGreaterThanOrEqual(2);
    expect(page.body.items.length).toBeGreaterThanOrEqual(2);
    expect(page.body.items[0]).toMatchObject({
      userId: driver.userId,
      currency: 'INR',
      direction: 'CREDIT',
    });

    const txId = page.body.items[0].transactionId;
    const detail = await request(app.getHttpServer())
      .get(`/admin/transactions/${txId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(detail.body.transactionId).toBe(txId);
    expect(detail.body.walletId).toBe(driver.walletId);
    expect(detail.body.completedAt).toBeNull();
    expect(detail.body.description).toBeNull();
    expect(detail.body.canReverse).toBe(true);

    await request(app.getHttpServer())
      .get(`/admin/transactions/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    await request(app.getHttpServer())
      .get('/admin/transactions')
      .query({ page: 0 })
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('reverses an eligible credit idempotently and preserves original row', async () => {
    const admin = await trackUser();
    const user = await trackUser();
    await ensureAdmin(admin.userId, [
      ADMIN_PERMISSION_TRANSACTIONS_VIEW,
      ADMIN_PERMISSION_TRANSACTIONS_REVERSE,
    ]);
    const token = await login(admin.userId);

    const credit = await walletService.creditPoints({
      walletId: user.walletId,
      userId: user.userId,
      amount: 200n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('admin-tx-rev-credit'),
    });

    const first = await request(app.getHttpServer())
      .post(`/admin/transactions/${credit.transaction.id}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Duplicate top-up correction' })
      .expect(200);

    expect(first.body.alreadyReversed).toBe(false);
    expect(first.body.reversal.type).toBe('ADMIN_ADJUSTMENT');
    expect(first.body.reversal.direction).toBe('DEBIT');
    expect(first.body.original.isReversed).toBe(true);

    const originalAfter = await dataSource
      .getRepository(WalletTransaction)
      .findOneByOrFail({ id: credit.transaction.id });
    expect(originalAfter.status).toBe('POSTED');
    expect(originalAfter.amount).toBe('200');

    const second = await request(app.getHttpServer())
      .post(`/admin/transactions/${credit.transaction.id}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'retry' })
      .expect(200);

    expect(second.body.alreadyReversed).toBe(true);
    expect(second.body.reversal.transactionId).toBe(
      first.body.reversal.transactionId,
    );

    const concurrent = await Promise.allSettled([
      request(app.getHttpServer())
        .post(`/admin/transactions/${credit.transaction.id}/reverse`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'concurrent-a' }),
      request(app.getHttpServer())
        .post(`/admin/transactions/${credit.transaction.id}/reverse`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'concurrent-b' }),
    ]);
    for (const r of concurrent) {
      expect(r.status).toBe('fulfilled');
    }

    const reverseCount = await dataSource
      .getRepository(WalletTransaction)
      .count({
        where: {
          parentTransactionId: credit.transaction.id,
          referenceType: 'ADMIN_TX_REVERSAL',
        },
      });
    expect(reverseCount).toBe(1);
  });

  it('rejects hold-type reversal and insufficient balance clawback', async () => {
    const admin = await trackUser();
    const user = await trackUser();
    await ensureAdmin(admin.userId, [
      ADMIN_PERMISSION_TRANSACTIONS_VIEW,
      ADMIN_PERMISSION_TRANSACTIONS_REVERSE,
    ]);
    const token = await login(admin.userId);

    await walletService.creditPoints({
      walletId: user.walletId,
      userId: user.userId,
      amount: 100n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('admin-tx-hold-setup'),
    });
    const hold = await walletService.createHold({
      walletId: user.walletId,
      amount: 40n,
      holdType: WalletHoldType.ASSURED_DEPOSIT,
      referenceType: 'TEST_HOLD',
      referenceId: randomUUID(),
      idempotencyKey: uniqueIdempotencyKey('admin-tx-hold'),
    });

    await request(app.getHttpServer())
      .post(`/admin/transactions/${hold.transaction.id}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'should fail hold' })
      .expect(422);

    // Spend remaining available so clawback of full credit fails.
    await walletService.debitPoints({
      walletId: user.walletId,
      userId: user.userId,
      amount: 60n,
      idempotencyKey: uniqueIdempotencyKey('admin-tx-spend'),
    });

    const credits = await dataSource.getRepository(WalletTransaction).find({
      where: {
        walletId: user.walletId,
        transactionType: WalletTransactionType.POINT_PURCHASE,
      },
    });
    const creditTx = credits[0];
    await request(app.getHttpServer())
      .post(`/admin/transactions/${creditTx.id}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'clawback after spend' })
      .expect(422);
  });
});
