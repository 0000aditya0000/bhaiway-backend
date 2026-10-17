import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { ADMIN_PERMISSION_DASHBOARD_VIEW } from '../admin/admin.constants';
import { AdminUser } from '../admin/entities/admin-user.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationType } from '../notifications/enums/notification.enums';
import { UserPaymentMethod } from './entities/user-payment-method.entity';
import { WalletHold, WalletHoldStatus, WalletHoldType } from './entities/wallet-hold.entity';
import { WalletPointSource } from './entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';
import { WithdrawalStatusHistory } from './entities/withdrawal-status-history.entity';
import { Withdrawal } from './entities/withdrawal.entity';
import { WithdrawalStatus } from './enums/withdrawal.enums';
import {
  assertWalletBalanceMatchesLots,
  TestWalletContext,
  uniqueIdempotencyKey,
} from './test/wallet-test.helpers';
import {
  bearer,
  cleanupWithdrawalTestWallet,
  createAdminFor,
  createTestWallet,
  createWithdrawalTestEnv,
  fundWallet,
  readBalance,
  WithdrawalTestEnv,
} from './test/withdrawal-test.helpers';
import { decryptAccountNumber } from './payment-method-crypto.util';

jest.setTimeout(90_000);

describe('Manual withdrawals (integration)', () => {
  let env: WithdrawalTestEnv;
  let app: INestApplication;
  let dataSource: DataSource;
  let secret: string;
  const tracked: TestWalletContext[] = [];

  beforeAll(async () => {
    env = await createWithdrawalTestEnv();
    app = env.app;
    dataSource = env.dataSource;
    const config = env.moduleRef.get(ConfigService);
    secret =
      config.get<string>('ENCRYPTION_KEY') ||
      config.get<string>('JWT_ACCESS_SECRET') ||
      '';
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await cleanupWithdrawalTestWallet(dataSource, ctx);
      }
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  interface TestUser {
    ctx: TestWalletContext;
    auth: string;
    methodId: string;
  }

  async function spawnUser(
    earned = 0n,
    purchased = 0n,
    promo = 0n,
  ): Promise<TestUser> {
    const ctx = await createTestWallet(dataSource);
    tracked.push(ctx);
    if (earned > 0n) {
      await fundWallet(env.walletService, ctx, WalletPointSource.DRIVER_EARNED, earned);
    }
    if (purchased > 0n) {
      await fundWallet(env.walletService, ctx, WalletPointSource.PURCHASED, purchased);
    }
    if (promo > 0n) {
      await fundWallet(env.walletService, ctx, WalletPointSource.PROMOTIONAL, promo);
    }
    const auth = bearer(env.jwtService, ctx.userId);
    const method = await request(app.getHttpServer())
      .post('/wallet/payment-methods')
      .set('Authorization', auth)
      .send({ type: 'UPI', upiId: `drv${Date.now()}${Math.floor(Math.random() * 1e6)}@okbank` })
      .expect(201);
    return { ctx, auth, methodId: method.body.id };
  }

  function withdraw(
    user: TestUser,
    amount: number | string,
    key: string | null = uniqueIdempotencyKey('wd'),
    methodId: string = user.methodId,
  ) {
    const req = request(app.getHttpServer())
      .post('/wallet/withdraw')
      .set('Authorization', user.auth);
    if (key !== null) {
      req.set('Idempotency-Key', key);
    }
    return req.send({ amount, paymentMethodId: methodId });
  }

  async function spawnAdmin(permissions?: string[]) {
    const ctx = await createTestWallet(dataSource);
    tracked.push(ctx);
    const admin = await createAdminFor(dataSource, ctx.userId, permissions);
    return { ctx, admin, auth: bearer(env.jwtService, ctx.userId) };
  }

  function setStatus(
    adminAuth: string,
    withdrawalId: string,
    status: string,
    remarks?: string,
  ) {
    return request(app.getHttpServer())
      .patch(`/admin/withdrawals/${withdrawalId}/status`)
      .set('Authorization', adminAuth)
      .send({ status, ...(remarks ? { remarks } : {}) });
  }

  async function holdsFor(walletId: string): Promise<WalletHold[]> {
    return dataSource.getRepository(WalletHold).find({ where: { walletId } });
  }

  async function txCount(
    walletId: string,
    transactionType: WalletTransactionType,
  ): Promise<number> {
    return dataSource
      .getRepository(WalletTransaction)
      .count({ where: { walletId, transactionType } });
  }

  // ---------------------------------------------------------------------------
  // creation
  // ---------------------------------------------------------------------------

  describe('POST /wallet/withdraw', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .set('Idempotency-Key', 'x')
        .send({ amount: 10, paymentMethodId: '00000000-0000-4000-8000-000000000000' })
        .expect(401);
    });

    it('creates an INITIATED withdrawal and holds only DRIVER_EARNED coins', async () => {
      const user = await spawnUser(1000n);

      const res = await withdraw(user, 400).expect(201);

      expect(res.body).toMatchObject({
        status: WithdrawalStatus.INITIATED,
        amount: '400',
        provider: 'MANUAL',
        paymentMethodType: 'UPI',
        paymentMethodId: user.methodId,
        processedAt: null,
        completedAt: null,
      });
      expect(res.body.referenceId).toMatch(/^WD-[A-Z2-9]{8}$/);

      const balance = await readBalance(dataSource, user.ctx.walletId);
      expect(balance.driverEarnedAvailable).toBe('600');
      expect(balance.driverEarnedHeld).toBe('400');
      await assertWalletBalanceMatchesLots(dataSource, user.ctx.walletId);

      const row = await dataSource
        .getRepository(Withdrawal)
        .findOneByOrFail({ id: res.body.id });
      expect(row.walletHoldId).toBeTruthy();
      expect(row.walletTransactionId).toBeTruthy();

      const hold = await dataSource
        .getRepository(WalletHold)
        .findOneByOrFail({ id: row.walletHoldId as string });
      expect(hold).toMatchObject({
        holdType: WalletHoldType.WITHDRAWAL,
        status: WalletHoldStatus.ACTIVE,
        amount: '400',
        referenceType: 'withdrawal',
        referenceId: row.id,
      });

      const tx = await dataSource
        .getRepository(WalletTransaction)
        .findOneByOrFail({ id: row.walletTransactionId as string });
      expect(tx.transactionType).toBe(WalletTransactionType.WITHDRAWAL);
      expect(tx.referenceType).toBe('withdrawal');
      expect(tx.referenceId).toBe(row.id);
      expect(tx.idempotencyKey.startsWith('withdrawal-hold:')).toBe(true);

      // No ASSURED hold ledger row is written for withdrawals.
      expect(
        await txCount(user.ctx.walletId, WalletTransactionType.ASSURED_DEPOSIT_HOLD),
      ).toBe(0);

      const notification = await dataSource
        .getRepository(Notification)
        .findOneBy({ idempotencyKey: `withdrawal-initiated:${row.id}` });
      expect(notification?.type).toBe(NotificationType.WITHDRAWAL_INITIATED);
      expect(notification?.body).toContain('400 Coins');
    });

    it('accepts amount as a numeric string', async () => {
      const user = await spawnUser(100n);
      const res = await withdraw(user, '25').expect(201);
      expect(res.body.amount).toBe('25');
    });

    it('requires Idempotency-Key', async () => {
      const user = await spawnUser(100n);
      const res = await withdraw(user, 10, null).expect(400);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

      const blank = await withdraw(user, 10, '   ').expect(400);
      expect(blank.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect(await holdsFor(user.ctx.walletId)).toHaveLength(0);
    });

    it.each([0, -5, 1.5, 'abc', '1e3', '-1', '0', '10.5', ' 10'])(
      'rejects invalid amount %p',
      async (amount) => {
        const user = await spawnUser(100n);
        const res = await withdraw(user, amount as number | string).expect(400);
        expect(res.body.code).toBe('INVALID_WITHDRAWAL_AMOUNT');
        expect(await holdsFor(user.ctx.walletId)).toHaveLength(0);
      },
    );

    it('rejects more than the earned balance with INSUFFICIENT_WITHDRAWABLE_BALANCE', async () => {
      const user = await spawnUser(100n);

      const res = await withdraw(user, 101).expect(422);
      expect(res.body.code).toBe('INSUFFICIENT_WITHDRAWABLE_BALANCE');

      const balance = await readBalance(dataSource, user.ctx.walletId);
      expect(balance.driverEarnedAvailable).toBe('100');
      expect(balance.driverEarnedHeld).toBe('0');
      expect(await holdsFor(user.ctx.walletId)).toHaveLength(0);
      expect(
        await dataSource
          .getRepository(Withdrawal)
          .count({ where: { walletId: user.ctx.walletId } }),
      ).toBe(0);
    });

    it('purchased and promotional coins are never withdrawable', async () => {
      const onlyPurchasedAndPromo = await spawnUser(0n, 1000n, 500n);
      const res = await withdraw(onlyPurchasedAndPromo, 100).expect(422);
      expect(res.body.code).toBe('INSUFFICIENT_WITHDRAWABLE_BALANCE');

      const mixed = await spawnUser(50n, 1000n, 500n);
      const tooMuch = await withdraw(mixed, 60).expect(422);
      expect(tooMuch.body.code).toBe('INSUFFICIENT_WITHDRAWABLE_BALANCE');

      let balance = await readBalance(dataSource, mixed.ctx.walletId);
      expect(balance.purchasedAvailable).toBe('1000');
      expect(balance.promotionalAvailable).toBe('500');
      expect(balance.driverEarnedAvailable).toBe('50');

      await withdraw(mixed, 50).expect(201);
      balance = await readBalance(dataSource, mixed.ctx.walletId);
      expect(balance.driverEarnedAvailable).toBe('0');
      expect(balance.driverEarnedHeld).toBe('50');
      expect(balance.purchasedAvailable).toBe('1000');
      expect(balance.purchasedHeld).toBe('0');
      expect(balance.promotionalAvailable).toBe('500');
      expect(balance.promotionalHeld).toBe('0');
      await assertWalletBalanceMatchesLots(dataSource, mixed.ctx.walletId);
    });

    it('rejects an unknown payment method, someone else\'s method, and an inactive method', async () => {
      const user = await spawnUser(500n);
      const other = await spawnUser(0n);

      const unknown = await withdraw(
        user,
        10,
        uniqueIdempotencyKey('wd'),
        '00000000-0000-4000-8000-0000000000aa',
      ).expect(404);
      expect(unknown.body.code).toBe('PAYMENT_METHOD_NOT_FOUND');

      const foreign = await withdraw(
        user,
        10,
        uniqueIdempotencyKey('wd'),
        other.methodId,
      ).expect(404);
      expect(foreign.body.code).toBe('PAYMENT_METHOD_NOT_FOUND');

      await dataSource
        .getRepository(UserPaymentMethod)
        .update({ id: user.methodId }, { isActive: false });
      const inactive = await withdraw(user, 10).expect(422);
      expect(inactive.body.code).toBe('PAYMENT_METHOD_INACTIVE');

      expect(await holdsFor(user.ctx.walletId)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // idempotency & concurrency
  // ---------------------------------------------------------------------------

  describe('idempotency', () => {
    it('replaying the same key returns the same withdrawal without a second hold', async () => {
      const user = await spawnUser(1000n);
      const key = uniqueIdempotencyKey('wd');

      const first = await withdraw(user, 300, key).expect(201);
      const second = await withdraw(user, 300, key).expect(201);

      expect(second.body.id).toBe(first.body.id);
      expect(second.body.referenceId).toBe(first.body.referenceId);
      expect(await holdsFor(user.ctx.walletId)).toHaveLength(1);
      expect(
        await txCount(user.ctx.walletId, WalletTransactionType.WITHDRAWAL),
      ).toBe(1);

      const balance = await readBalance(dataSource, user.ctx.walletId);
      expect(balance.driverEarnedAvailable).toBe('700');
      expect(balance.driverEarnedHeld).toBe('300');
    });

    it('same key with a different amount or method → WITHDRAWAL_IDEMPOTENCY_CONFLICT', async () => {
      const user = await spawnUser(1000n);
      const key = uniqueIdempotencyKey('wd');
      await withdraw(user, 300, key).expect(201);

      const diffAmount = await withdraw(user, 301, key).expect(409);
      expect(diffAmount.body.code).toBe('WITHDRAWAL_IDEMPOTENCY_CONFLICT');

      const second = await request(app.getHttpServer())
        .post('/wallet/payment-methods')
        .set('Authorization', user.auth)
        .send({ type: 'UPI', upiId: `other${Date.now()}@okbank` })
        .expect(201);
      const diffMethod = await withdraw(user, 300, key, second.body.id).expect(409);
      expect(diffMethod.body.code).toBe('WITHDRAWAL_IDEMPOTENCY_CONFLICT');

      expect(await holdsFor(user.ctx.walletId)).toHaveLength(1);
    });

    it('the same client key from two different users creates independent withdrawals', async () => {
      const a = await spawnUser(100n);
      const b = await spawnUser(100n);
      const key = uniqueIdempotencyKey('shared');

      const ra = await withdraw(a, 40, key).expect(201);
      const rb = await withdraw(b, 40, key).expect(201);

      expect(ra.body.id).not.toBe(rb.body.id);
      for (const user of [a, b]) {
        const balance = await readBalance(dataSource, user.ctx.walletId);
        expect(balance.driverEarnedHeld).toBe('40');
        expect(await holdsFor(user.ctx.walletId)).toHaveLength(1);
      }
    });

    it('concurrent requests with the same key create exactly one withdrawal and hold', async () => {
      const user = await spawnUser(1000n);
      const key = uniqueIdempotencyKey('race');

      const results = await Promise.all(
        Array.from({ length: 6 }, () => withdraw(user, 200, key)),
      );

      for (const res of results) {
        expect(res.status).toBe(201);
      }
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(
        await dataSource
          .getRepository(Withdrawal)
          .count({ where: { walletId: user.ctx.walletId } }),
      ).toBe(1);
      expect(await holdsFor(user.ctx.walletId)).toHaveLength(1);

      const balance = await readBalance(dataSource, user.ctx.walletId);
      expect(balance.driverEarnedAvailable).toBe('800');
      expect(balance.driverEarnedHeld).toBe('200');
      await assertWalletBalanceMatchesLots(dataSource, user.ctx.walletId);
    });
  });

  describe('concurrency', () => {
    it('never over-holds when parallel withdrawals race for the same balance', async () => {
      const user = await spawnUser(100n);

      const results = await Promise.all(
        Array.from({ length: 6 }, () => withdraw(user, 50)),
      );

      const ok = results.filter((r) => r.status === 201);
      const rejected = results.filter((r) => r.status === 422);
      expect(ok).toHaveLength(2);
      expect(rejected).toHaveLength(4);
      for (const res of rejected) {
        expect(res.body.code).toBe('INSUFFICIENT_WITHDRAWABLE_BALANCE');
      }

      const balance = await readBalance(dataSource, user.ctx.walletId);
      expect(balance.driverEarnedAvailable).toBe('0');
      expect(balance.driverEarnedHeld).toBe('100');
      expect(await holdsFor(user.ctx.walletId)).toHaveLength(2);
      expect(
        await dataSource
          .getRepository(Withdrawal)
          .count({ where: { walletId: user.ctx.walletId } }),
      ).toBe(2);
      await assertWalletBalanceMatchesLots(dataSource, user.ctx.walletId);
    });
  });

  // ---------------------------------------------------------------------------
  // user reads
  // ---------------------------------------------------------------------------

  describe('GET /wallet/withdrawals', () => {
    it('lists own withdrawals newest first with pagination', async () => {
      const user = await spawnUser(1000n);
      const stranger = await spawnUser(100n);
      const ids: string[] = [];
      for (let i = 1; i <= 3; i += 1) {
        const res = await withdraw(user, 10 * i).expect(201);
        ids.push(res.body.id);
      }
      await withdraw(stranger, 10).expect(201);

      const page1 = await request(app.getHttpServer())
        .get('/wallet/withdrawals?page=1&limit=2')
        .set('Authorization', user.auth)
        .expect(200);
      expect(page1.body).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect(page1.body.items.map((i: { id: string }) => i.id)).toEqual([
        ids[2],
        ids[1],
      ]);

      const page2 = await request(app.getHttpServer())
        .get('/wallet/withdrawals?page=2&limit=2')
        .set('Authorization', user.auth)
        .expect(200);
      expect(page2.body.items.map((i: { id: string }) => i.id)).toEqual([ids[0]]);
    });

    it('returns an empty page for a user without withdrawals', async () => {
      const user = await spawnUser();
      const res = await request(app.getHttpServer())
        .get('/wallet/withdrawals')
        .set('Authorization', user.auth)
        .expect(200);
      expect(res.body).toMatchObject({ items: [], total: 0, totalPages: 0 });
    });

    it('GET /:id returns own, 403 for others, 404 for unknown', async () => {
      const owner = await spawnUser(100n);
      const other = await spawnUser(0n);
      const created = await withdraw(owner, 10).expect(201);

      const mine = await request(app.getHttpServer())
        .get(`/wallet/withdrawals/${created.body.id}`)
        .set('Authorization', owner.auth)
        .expect(200);
      expect(mine.body.id).toBe(created.body.id);
      expect(mine.body).not.toHaveProperty('walletHoldId');
      expect(mine.body).not.toHaveProperty('userId');

      const denied = await request(app.getHttpServer())
        .get(`/wallet/withdrawals/${created.body.id}`)
        .set('Authorization', other.auth)
        .expect(403);
      expect(denied.body.code).toBe('WITHDRAWAL_ACCESS_DENIED');

      const missing = await request(app.getHttpServer())
        .get('/wallet/withdrawals/00000000-0000-4000-8000-0000000000bb')
        .set('Authorization', owner.auth)
        .expect(404);
      expect(missing.body.code).toBe('WITHDRAWAL_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // admin
  // ---------------------------------------------------------------------------

  describe('admin /admin/withdrawals', () => {
    it('rejects unauthenticated, non-admin, and admins without the permission', async () => {
      const user = await spawnUser(100n);
      const created = await withdraw(user, 10).expect(201);
      const wrongPerm = await spawnAdmin([ADMIN_PERMISSION_DASHBOARD_VIEW]);

      await request(app.getHttpServer()).get('/admin/withdrawals').expect(401);

      const nonAdmin = await request(app.getHttpServer())
        .get('/admin/withdrawals')
        .set('Authorization', user.auth)
        .expect(403);
      expect(nonAdmin.body.code).toBe('ADMIN_ACCESS_DENIED');

      const noPerm = await request(app.getHttpServer())
        .get('/admin/withdrawals')
        .set('Authorization', wrongPerm.auth)
        .expect(403);
      expect(noPerm.body.code).toBe('ADMIN_PERMISSION_DENIED');

      await setStatus(user.auth, created.body.id, 'PROCESSING').expect(403);
      await setStatus(wrongPerm.auth, created.body.id, 'PROCESSING').expect(403);
    });

    it('lists with status filter and pagination, and returns detail with history', async () => {
      const admin = await spawnAdmin();
      const user = await spawnUser(1000n);
      const a = await withdraw(user, 10).expect(201);
      const b = await withdraw(user, 20).expect(201);
      await setStatus(admin.auth, b.body.id, 'PROCESSING').expect(200);

      const processing = await request(app.getHttpServer())
        .get('/admin/withdrawals?status=PROCESSING&limit=50')
        .set('Authorization', admin.auth)
        .expect(200);
      const processingIds = processing.body.items.map((i: { id: string }) => i.id);
      expect(processingIds).toContain(b.body.id);
      expect(processingIds).not.toContain(a.body.id);
      for (const item of processing.body.items) {
        expect(item.status).toBe('PROCESSING');
        if (item.id === b.body.id) {
          expect(item.userId).toBe(user.ctx.userId);
          expect(item.userName).toBe('Test Wallet');
        }
      }

      const initiated = await request(app.getHttpServer())
        .get('/admin/withdrawals?status=INITIATED&limit=50')
        .set('Authorization', admin.auth)
        .expect(200);
      expect(initiated.body.items.map((i: { id: string }) => i.id)).toContain(
        a.body.id,
      );

      await request(app.getHttpServer())
        .get('/admin/withdrawals?status=BOGUS')
        .set('Authorization', admin.auth)
        .expect(400);

      const detail = await request(app.getHttpServer())
        .get(`/admin/withdrawals/${b.body.id}`)
        .set('Authorization', admin.auth)
        .expect(200);
      expect(detail.body).toMatchObject({
        id: b.body.id,
        userId: user.ctx.userId,
        userName: 'Test Wallet',
        walletId: user.ctx.walletId,
        status: 'PROCESSING',
      });
      expect(detail.body.walletHoldId).toBeTruthy();
      expect(detail.body.statusHistory).toHaveLength(1);
      expect(detail.body.statusHistory[0]).toMatchObject({
        previousStatus: 'INITIATED',
        newStatus: 'PROCESSING',
        adminUserId: admin.admin.id,
      });

      const missing = await request(app.getHttpServer())
        .get('/admin/withdrawals/00000000-0000-4000-8000-0000000000cc')
        .set('Authorization', admin.auth)
        .expect(404);
      expect(missing.body.code).toBe('WITHDRAWAL_NOT_FOUND');
    });

    it('INITIATED → PROCESSING → COMPLETED consumes the hold and records history', async () => {
      const admin = await spawnAdmin();
      const user = await spawnUser(1000n);
      const created = await withdraw(user, 400).expect(201);

      const processing = await setStatus(
        admin.auth,
        created.body.id,
        'PROCESSING',
        'Payout batch started',
      ).expect(200);
      expect(processing.body.status).toBe('PROCESSING');
      expect(processing.body.processedAt).toBeTruthy();
      expect(processing.body.adminRemarks).toBe('Payout batch started');

      // Hold still active, funds still reserved.
      let balance = await readBalance(dataSource, user.ctx.walletId);
      expect(balance.driverEarnedHeld).toBe('400');

      const completed = await setStatus(
        admin.auth,
        created.body.id,
        'COMPLETED',
        'UTR 123',
      ).expect(200);
      expect(completed.body.status).toBe('COMPLETED');
      expect(completed.body.completedAt).toBeTruthy();

      balance = await readBalance(dataSource, user.ctx.walletId);
      expect(balance.driverEarnedAvailable).toBe('600');
      expect(balance.driverEarnedHeld).toBe('0');
      await assertWalletBalanceMatchesLots(dataSource, user.ctx.walletId);

      const [hold] = await holdsFor(user.ctx.walletId);
      expect(hold.status).toBe(WalletHoldStatus.CONSUMED);
      expect(
        await txCount(user.ctx.walletId, WalletTransactionType.HOLD_CONSUMED),
      ).toBe(1);
      const consumeTx = await dataSource
        .getRepository(WalletTransaction)
        .findOneByOrFail({
          walletId: user.ctx.walletId,
          transactionType: WalletTransactionType.HOLD_CONSUMED,
        });
      expect(consumeTx.idempotencyKey).toBe(`withdrawal-consume:${created.body.id}`);
      expect(consumeTx.parentTransactionId).toBeTruthy();

      const history = await dataSource
        .getRepository(WithdrawalStatusHistory)
        .find({ where: { withdrawalId: created.body.id }, order: { createdAt: 'ASC' } });
      expect(history.map((h) => [h.previousStatus, h.newStatus])).toEqual([
        ['INITIATED', 'PROCESSING'],
        ['PROCESSING', 'COMPLETED'],
      ]);
      for (const row of history) {
        expect(row.adminUserId).toBe(admin.admin.id);
      }
      expect(history[1].remarks).toBe('UTR 123');

      // Notifications: PROCESSING and COMPLETED.
      const notifications = await dataSource.getRepository(Notification).find({
        where: { recipientUserId: user.ctx.userId },
      });
      const types = notifications.map((n) => n.type);
      expect(types).toEqual(
        expect.arrayContaining([
          NotificationType.WITHDRAWAL_INITIATED,
          NotificationType.WITHDRAWAL_PROCESSING,
          NotificationType.WITHDRAWAL_COMPLETED,
        ]),
      );

      // User view reflects COMPLETED.
      const userView = await request(app.getHttpServer())
        .get(`/wallet/withdrawals/${created.body.id}`)
        .set('Authorization', user.auth)
        .expect(200);
      expect(userView.body.status).toBe('COMPLETED');
    });

    it('COMPLETED is terminal', async () => {
      const admin = await spawnAdmin();
      const user = await spawnUser(100n);
      const created = await withdraw(user, 50).expect(201);
      await setStatus(admin.auth, created.body.id, 'PROCESSING').expect(200);
      await setStatus(admin.auth, created.body.id, 'COMPLETED').expect(200);

      const again = await setStatus(admin.auth, created.body.id, 'COMPLETED').expect(409);
      expect(again.body.code).toBe('WITHDRAWAL_ALREADY_COMPLETED');

      for (const status of ['PROCESSING', 'FAILED', 'CANCELLED', 'INITIATED']) {
        const res = await setStatus(admin.auth, created.body.id, status).expect(422);
        expect(res.body.code).toBe('INVALID_WITHDRAWAL_STATUS_TRANSITION');
      }

      const balance = await readBalance(dataSource, user.ctx.walletId);
      expect(balance.driverEarnedAvailable).toBe('50');
      expect(balance.driverEarnedHeld).toBe('0');
      expect(
        await txCount(user.ctx.walletId, WalletTransactionType.HOLD_CONSUMED),
      ).toBe(1);
      expect(
        await txCount(user.ctx.walletId, WalletTransactionType.HOLD_RELEASE),
      ).toBe(0);
    });

    it('rejects invalid transitions with 422 and changes nothing', async () => {
      const admin = await spawnAdmin();
      const user = await spawnUser(100n);
      const created = await withdraw(user, 50).expect(201);

      for (const status of ['COMPLETED', 'INITIATED']) {
        const res = await setStatus(admin.auth, created.body.id, status).expect(422);
        expect(res.body.code).toBe('INVALID_WITHDRAWAL_STATUS_TRANSITION');
      }
      await setStatus(admin.auth, created.body.id, 'BOGUS').expect(400);

      const row = await dataSource
        .getRepository(Withdrawal)
        .findOneByOrFail({ id: created.body.id });
      expect(row.status).toBe(WithdrawalStatus.INITIATED);
      expect(
        await dataSource
          .getRepository(WithdrawalStatusHistory)
          .count({ where: { withdrawalId: created.body.id } }),
      ).toBe(0);
      const balance = await readBalance(dataSource, user.ctx.walletId);
      expect(balance.driverEarnedHeld).toBe('50');
    });

    it('returns 404 for an unknown withdrawal', async () => {
      const admin = await spawnAdmin();
      const res = await setStatus(
        admin.auth,
        '00000000-0000-4000-8000-0000000000dd',
        'PROCESSING',
      ).expect(404);
      expect(res.body.code).toBe('WITHDRAWAL_NOT_FOUND');
    });

    it.each([
      ['INITIATED', 'FAILED'],
      ['INITIATED', 'CANCELLED'],
      ['PROCESSING', 'FAILED'],
      ['PROCESSING', 'CANCELLED'],
    ])('%s → %s releases the hold exactly once and restores earned coins', async (from, to) => {
      const admin = await spawnAdmin();
      const user = await spawnUser(500n);
      const created = await withdraw(user, 300).expect(201);
      if (from === 'PROCESSING') {
        await setStatus(admin.auth, created.body.id, 'PROCESSING').expect(200);
      }

      let balance = await readBalance(dataSource, user.ctx.walletId);
      expect(balance.driverEarnedAvailable).toBe('200');
      expect(balance.driverEarnedHeld).toBe('300');

      const res = await setStatus(admin.auth, created.body.id, to, 'Bank rejected').expect(200);
      expect(res.body.status).toBe(to);
      expect(res.body.adminRemarks).toBe('Bank rejected');

      balance = await readBalance(dataSource, user.ctx.walletId);
      expect(balance.driverEarnedAvailable).toBe('500');
      expect(balance.driverEarnedHeld).toBe('0');
      await assertWalletBalanceMatchesLots(dataSource, user.ctx.walletId);

      const [hold] = await holdsFor(user.ctx.walletId);
      expect(hold.status).toBe(WalletHoldStatus.RELEASED);
      expect(
        await txCount(user.ctx.walletId, WalletTransactionType.HOLD_RELEASE),
      ).toBe(1);
      const releaseTx = await dataSource
        .getRepository(WalletTransaction)
        .findOneByOrFail({
          walletId: user.ctx.walletId,
          transactionType: WalletTransactionType.HOLD_RELEASE,
        });
      expect(releaseTx.idempotencyKey).toBe(
        `withdrawal-release:${created.body.id}:${to}`,
      );

      // Repeating or switching terminal state is rejected and never restores twice.
      for (const status of ['FAILED', 'CANCELLED', 'COMPLETED', 'PROCESSING']) {
        const again = await setStatus(admin.auth, created.body.id, status).expect(422);
        expect(again.body.code).toBe('INVALID_WITHDRAWAL_STATUS_TRANSITION');
      }
      balance = await readBalance(dataSource, user.ctx.walletId);
      expect(balance.driverEarnedAvailable).toBe('500');
      expect(
        await txCount(user.ctx.walletId, WalletTransactionType.HOLD_RELEASE),
      ).toBe(1);
    });

    it('concurrent FAILED/CANCELLED updates restore the balance only once', async () => {
      const admin = await spawnAdmin();
      const user = await spawnUser(500n);
      const created = await withdraw(user, 300).expect(201);

      const results = await Promise.all([
        setStatus(admin.auth, created.body.id, 'FAILED'),
        setStatus(admin.auth, created.body.id, 'FAILED'),
        setStatus(admin.auth, created.body.id, 'CANCELLED'),
        setStatus(admin.auth, created.body.id, 'FAILED'),
      ]);

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      for (const res of results.filter((r) => r.status !== 200)) {
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('INVALID_WITHDRAWAL_STATUS_TRANSITION');
      }

      const balance = await readBalance(dataSource, user.ctx.walletId);
      expect(balance.driverEarnedAvailable).toBe('500');
      expect(balance.driverEarnedHeld).toBe('0');
      expect(
        await txCount(user.ctx.walletId, WalletTransactionType.HOLD_RELEASE),
      ).toBe(1);
      expect(
        await dataSource
          .getRepository(WithdrawalStatusHistory)
          .count({ where: { withdrawalId: created.body.id } }),
      ).toBe(1);
    });

    it('released coins can be withdrawn again after FAILED', async () => {
      const admin = await spawnAdmin();
      const user = await spawnUser(100n);
      const first = await withdraw(user, 100).expect(201);
      await withdraw(user, 1).expect(422);
      await setStatus(admin.auth, first.body.id, 'FAILED').expect(200);
      await withdraw(user, 100).expect(201);
    });
  });

  // ---------------------------------------------------------------------------
  // snapshot immutability
  // ---------------------------------------------------------------------------

  describe('payment method snapshot', () => {
    it('is immutable when the payment method is later edited or deleted', async () => {
      const admin = await spawnAdmin();
      const user = await spawnUser(1000n);

      const bank = await request(app.getHttpServer())
        .post('/wallet/payment-methods')
        .set('Authorization', user.auth)
        .send({
          type: 'BANK_ACCOUNT',
          accountHolderName: 'Asha Verma',
          accountNumber: '123456789012',
          ifscCode: 'HDFC0001234',
          bankName: 'HDFC Bank',
        })
        .expect(201);

      const created = await withdraw(user, 100, uniqueIdempotencyKey('wd'), bank.body.id).expect(
        201,
      );
      expect(created.body.paymentMethodType).toBe('BANK_ACCOUNT');
      expect(created.body.paymentMethod).toEqual({
        type: 'BANK_ACCOUNT',
        upiId: null,
        accountHolderName: 'Asha Verma',
        accountNumberMasked: 'XXXX XXXX 9012',
        ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank',
      });
      expect(JSON.stringify(created.body)).not.toContain('123456789012');
      expect(JSON.stringify(created.body)).not.toContain('Encrypted');

      const before = await dataSource
        .getRepository(Withdrawal)
        .findOneByOrFail({ id: created.body.id });

      await request(app.getHttpServer())
        .patch(`/wallet/payment-methods/${bank.body.id}`)
        .set('Authorization', user.auth)
        .send({ bankName: 'Other Bank', accountNumber: '999900001111', accountHolderName: 'Someone Else' })
        .expect(200);
      const del = await request(app.getHttpServer())
        .delete(`/wallet/payment-methods/${bank.body.id}`)
        .set('Authorization', user.auth)
        .expect(200);
      expect(del.body).toMatchObject({ deleted: false, deactivated: true });

      const after = await dataSource
        .getRepository(Withdrawal)
        .findOneByOrFail({ id: created.body.id });
      expect(after.paymentMethodSnapshot).toEqual(before.paymentMethodSnapshot);
      expect(after.paymentMethodSnapshot.bankName).toBe('HDFC Bank');
      expect(after.paymentMethodSnapshot.accountNumberLast4).toBe('9012');

      const userView = await request(app.getHttpServer())
        .get(`/wallet/withdrawals/${created.body.id}`)
        .set('Authorization', user.auth)
        .expect(200);
      expect(userView.body.paymentMethod).toEqual(created.body.paymentMethod);

      // Admin sees the original full account number for the manual payout.
      const detail = await request(app.getHttpServer())
        .get(`/admin/withdrawals/${created.body.id}`)
        .set('Authorization', admin.auth)
        .expect(200);
      expect(detail.body.payoutAccountNumber).toBe('123456789012');
      expect(
        decryptAccountNumber(
          after.paymentMethodSnapshot.accountNumberEncrypted as string,
          secret,
        ),
      ).toBe('123456789012');

      // Admin list never exposes the full number.
      const list = await request(app.getHttpServer())
        .get('/admin/withdrawals?limit=50')
        .set('Authorization', admin.auth)
        .expect(200);
      const listed = list.body.items.find((i: { id: string }) => i.id === created.body.id);
      expect(listed).toBeDefined();
      expect(listed.payoutAccountNumber).toBeUndefined();

      // Deactivated method can no longer be used for new withdrawals.
      const reuse = await withdraw(user, 10, uniqueIdempotencyKey('wd'), bank.body.id).expect(
        422,
      );
      expect(reuse.body.code).toBe('PAYMENT_METHOD_INACTIVE');
    });

    it('keeps the AdminUser/History link intact when an admin row is removed', async () => {
      const admin = await spawnAdmin();
      const user = await spawnUser(100n);
      const created = await withdraw(user, 10).expect(201);
      await setStatus(admin.auth, created.body.id, 'PROCESSING').expect(200);

      await dataSource.getRepository(AdminUser).delete({ id: admin.admin.id });
      const history = await dataSource
        .getRepository(WithdrawalStatusHistory)
        .find({ where: { withdrawalId: created.body.id } });
      expect(history).toHaveLength(1);
      expect(history[0].adminUserId).toBeNull();
    });
  });
});
