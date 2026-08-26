import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { UsersModule } from '../users/users.module';
import { PaymentOrder } from './entities/payment-order.entity';
import {
  PaymentOrderProvider,
  PaymentOrderStatus,
} from './enums/payment-order.enums';
import { WalletBalance } from './entities/wallet-balance.entity';
import {
  WalletPointLot,
  WalletPointSource,
} from './entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';
import { Wallet, WalletStatus } from './entities/wallet.entity';
import {
  MOCK_SIGNATURE_HEADER,
  signMockCallbackPayload,
} from './payment/mock-payment.gateway';
import { PaymentGatewayStatus } from './payment/payment-gateway.types';
import {
  TOP_UP_CREDIT_IDEMPOTENCY_PREFIX,
} from './wallet.constants';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  createTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from './test/wallet-test.helpers';
import { TopUpService } from './top-up.service';
import { WalletModule } from './wallet.module';
import { WalletService } from './wallet.service';

const WEBHOOK_SECRET = 'test-webhook-secret-phase3';

describe('Wallet top-up (Phase 3 integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let jwtService: JwtService;
  let walletService: WalletService;
  let topUpService: TopUpService;
  const tracked: TestWalletContext[] = [];

  beforeAll(async () => {
    process.env.PAYMENT_GATEWAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.PAYMENT_GATEWAY_PROVIDER = 'mock';
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
    jwtService = moduleRef.get(JwtService);
    walletService = moduleRef.get(WalletService);
    topUpService = moduleRef.get(TopUpService);
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await dataSource.getRepository(PaymentOrder).delete({
          walletId: ctx.walletId,
        });
        await cleanupTestWallet(dataSource, ctx);
      }
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  async function spawnWallet(): Promise<TestWalletContext> {
    const ctx = await createTestWallet(dataSource);
    tracked.push(ctx);
    return ctx;
  }

  function bearerToken(userId: string): string {
    return jwtService.sign({ sub: userId });
  }

  async function createAuthenticatedUser() {
    const phone = `+91${Date.now().toString().slice(-10)}${Math.floor(
      Math.random() * 10,
    )}`;
    const login = await authService.loginOrRegisterWithVerifiedIdentity({
      phone,
      verified: true,
    });
    const wallet = await dataSource.getRepository(Wallet).findOneByOrFail({
      userId: login.user.id,
    });
    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });

    tracked.push({
      userId: login.user.id,
      walletId: wallet.id,
      balanceId: balance.id,
      phone,
    });

    return login;
  }

  async function createTopUp(
    userId: string,
    amount: string,
    idempotencyKey: string,
  ) {
    return request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(userId)}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ amount })
      .expect(201);
  }

  function buildSignedCallback(
    order: PaymentOrder,
    status: PaymentGatewayStatus,
    overrides: Partial<{
      amount: string;
      currency: string;
      gatewayOrderId: string;
      reference: string;
    }> = {},
  ) {
    const payload = {
      gatewayOrderId: overrides.gatewayOrderId ?? order.gatewayOrderId!,
      amount: overrides.amount ?? order.amount,
      currency: overrides.currency ?? order.currency,
      status,
      reference: overrides.reference ?? uniqueIdempotencyKey('cb-ref'),
    };
    const signature = signMockCallbackPayload(payload, WEBHOOK_SECRET);
    return { payload, signature };
  }

  async function postCallback(
    payload: Record<string, unknown>,
    signature: string,
    expectedStatus = 200,
  ) {
    return request(app.getHttpServer())
      .post('/wallet/top-up/callback')
      .set(MOCK_SIGNATURE_HEADER, signature)
      .send(payload)
      .expect(expectedStatus);
  }

  async function loadOrder(paymentOrderId: string): Promise<PaymentOrder> {
    return dataSource.getRepository(PaymentOrder).findOneByOrFail({
      id: paymentOrderId,
    });
  }

  it('A: creates top-up successfully', async () => {
    const ctx = await spawnWallet();
    const key = uniqueIdempotencyKey('topup-create');

    const response = await createTopUp(ctx.userId, '500', key);

    expect(response.body).toMatchObject({
      amount: '500',
      currency: 'INR',
      status: PaymentOrderStatus.PENDING,
      provider: PaymentOrderProvider.MOCK,
      gatewayOrderId: `mock_${response.body.paymentOrderId}`,
    });
    expect(response.body.mockInstructions).toBeDefined();
    expect(response.body.walletTransactionId).toBeNull();
  });

  it('B: requires Idempotency-Key', async () => {
    const ctx = await spawnWallet();

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .send({ amount: '100' })
      .expect(400);
  });

  it('C: same idempotency key + same amount returns existing order', async () => {
    const ctx = await spawnWallet();
    const key = uniqueIdempotencyKey('topup-idem');

    const first = await createTopUp(ctx.userId, '500', key);
    const second = await createTopUp(ctx.userId, '500', key);

    expect(second.body.paymentOrderId).toBe(first.body.paymentOrderId);
    expect(
      await dataSource.getRepository(PaymentOrder).count({
        where: { idempotencyKey: key },
      }),
    ).toBe(1);
  });

  it('D: same idempotency key + different amount → 409', async () => {
    const ctx = await spawnWallet();
    const key = uniqueIdempotencyKey('topup-conflict');

    await createTopUp(ctx.userId, '500', key);

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', key)
      .send({ amount: '600' })
      .expect(409);
  });

  it('E: concurrent same-key create → one payment order', async () => {
    const ctx = await spawnWallet();
    const key = uniqueIdempotencyKey('topup-concurrent');

    const [a, b] = await Promise.all([
      request(app.getHttpServer())
        .post('/wallet/top-up')
        .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
        .set('Idempotency-Key', key)
        .send({ amount: '250' }),
      request(app.getHttpServer())
        .post('/wallet/top-up')
        .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
        .set('Idempotency-Key', key)
        .send({ amount: '250' }),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect(a.body.paymentOrderId).toBe(b.body.paymentOrderId);
    expect(
      await dataSource.getRepository(PaymentOrder).count({
        where: { idempotencyKey: key },
      }),
    ).toBe(1);
  });

  it('F: mock SUCCESS callback → one wallet credit', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '500', uniqueIdempotencyKey('success'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
    );

    const callback = await postCallback(payload, signature);

    expect(callback.body.status).toBe(PaymentOrderStatus.SUCCESS);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(1);
  });

  it('G: SUCCESS creates PURCHASED lot', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '300', uniqueIdempotencyKey('lot'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
    );
    await postCallback(payload, signature);

    const lots = await dataSource.getRepository(WalletPointLot).find({
      where: { walletId: ctx.walletId },
    });
    expect(lots).toHaveLength(1);
    expect(lots[0].sourceType).toBe(WalletPointSource.PURCHASED);
    expect(lots[0].availableAmount).toBe('300');
  });

  it('H: SUCCESS creates POINT_PURCHASE ledger entry', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '400', uniqueIdempotencyKey('ledger'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
    );
    await postCallback(payload, signature);

    const txs = await dataSource.getRepository(WalletTransaction).find({
      where: { walletId: ctx.walletId },
    });
    expect(txs).toHaveLength(1);
    expect(txs[0].transactionType).toBe(WalletTransactionType.POINT_PURCHASE);
    expect(txs[0].amount).toBe('400');
  });

  it('I: payment order links wallet_transaction_id', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '150', uniqueIdempotencyKey('link'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
    );
    const callback = await postCallback(payload, signature);

    const updated = await loadOrder(order.id);
    expect(updated.walletTransactionId).toBeTruthy();
    expect(callback.body.walletTransactionId).toBe(updated.walletTransactionId);
  });

  it('J: duplicate SUCCESS callback → no duplicate credit', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '500', uniqueIdempotencyKey('dup-success'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
    );

    const first = await postCallback(payload, signature);
    const second = await postCallback(payload, signature);

    expect(second.body.paymentOrderId).toBe(first.body.paymentOrderId);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(1);
  });

  it('K: concurrent duplicate SUCCESS callbacks → one credit', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '500', uniqueIdempotencyKey('conc-success'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
    );

    const [a, b] = await Promise.all([
      postCallback(payload, signature),
      postCallback(payload, signature),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(1);
  });

  it('L: FAILED callback → no credit', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '500', uniqueIdempotencyKey('failed'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.FAILED,
    );
    const callback = await postCallback(payload, signature);

    expect(callback.body.status).toBe(PaymentOrderStatus.FAILED);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(0);
  });

  it('M: CANCELLED callback → no credit', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '500', uniqueIdempotencyKey('cancelled'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.CANCELLED,
    );
    const callback = await postCallback(payload, signature);

    expect(callback.body.status).toBe(PaymentOrderStatus.CANCELLED);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(0);
  });

  it('N: invalid signature → no credit', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '500', uniqueIdempotencyKey('bad-sig'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload } = buildSignedCallback(order, PaymentGatewayStatus.SUCCESS);

    await postCallback(payload, 'deadbeef', 400);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(0);
  });

  it('O: unknown gateway order → no credit', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '500', uniqueIdempotencyKey('unknown'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
      { gatewayOrderId: 'mock_unknown_order' },
    );

    await postCallback(payload, signature, 404);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(0);
  });

  it('P: amount mismatch → no credit', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '500', uniqueIdempotencyKey('amt-mismatch'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
      { amount: '1000' },
    );

    await postCallback(payload, signature, 422);

    const updated = await loadOrder(order.id);
    expect(updated.status).toBe(PaymentOrderStatus.PENDING);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(0);
  });

  it('Q: currency mismatch → no credit', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '500', uniqueIdempotencyKey('cur-mismatch'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
      { currency: 'USD' },
    );

    await postCallback(payload, signature, 422);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(0);
  });

  it('R: suspended wallet → top-up rejected', async () => {
    const ctx = await spawnWallet();
    await dataSource.getRepository(Wallet).update(ctx.walletId, {
      status: WalletStatus.SUSPENDED,
    });

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('suspended'))
      .send({ amount: '100' })
      .expect(403);
  });

  it('S: locked wallet → top-up rejected', async () => {
    const ctx = await spawnWallet();
    await dataSource.getRepository(Wallet).update(ctx.walletId, {
      status: WalletStatus.LOCKED,
    });

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('locked'))
      .send({ amount: '100' })
      .expect(403);
  });

  it('T: wallet balance increases exactly by successful top-up amount', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '750', uniqueIdempotencyKey('balance'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
    );
    await postCallback(payload, signature);

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    expect(balance.purchasedAvailable).toBe('750');
  });

  it('U: failed/cancelled payment leaves wallet unchanged', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '500', uniqueIdempotencyKey('unchanged'));
    const order = await loadOrder(created.body.paymentOrderId);
    const failed = buildSignedCallback(order, PaymentGatewayStatus.FAILED);
    await postCallback(failed.payload, failed.signature);

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    expect(balance.purchasedAvailable).toBe('0');
  });

  it('V: transaction rollback if wallet credit fails', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '500', uniqueIdempotencyKey('rollback'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
    );

    const creditSpy = jest
      .spyOn(walletService, 'creditPointsInTransaction')
      .mockRejectedValueOnce(new Error('simulated credit failure'));

    await postCallback(payload, signature, 500);

    creditSpy.mockRestore();

    const updated = await loadOrder(order.id);
    expect(updated.status).toBe(PaymentOrderStatus.PENDING);
    expect(updated.walletTransactionId).toBeNull();
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(0);
  });

  it('W: callback reference persisted', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '200', uniqueIdempotencyKey('cb-ref'));
    const order = await loadOrder(created.body.paymentOrderId);
    const reference = uniqueIdempotencyKey('gateway-ref');
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
      { reference },
    );
    const callback = await postCallback(payload, signature);

    expect(callback.body.callbackReference).toBe(reference);
    const updated = await loadOrder(order.id);
    expect(updated.callbackReference).toBe(reference);
  });

  it('X: callback status handling is idempotent for FAILED', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '500', uniqueIdempotencyKey('idem-failed'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.FAILED,
    );

    await postCallback(payload, signature);
    await postCallback(payload, signature);

    expect(
      await dataSource.getRepository(PaymentOrder).count({
        where: { walletId: ctx.walletId, status: PaymentOrderStatus.FAILED },
      }),
    ).toBe(1);
  });

  it('Y: wallet credit uses payment-order idempotency key', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '500', uniqueIdempotencyKey('credit-key'));
    const order = await loadOrder(created.body.paymentOrderId);
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
    );
    await postCallback(payload, signature);

    const tx = await dataSource.getRepository(WalletTransaction).findOneOrFail({
      where: {
        walletId: ctx.walletId,
        idempotencyKey: `${TOP_UP_CREDIT_IDEMPOTENCY_PREFIX}${order.id}`,
      },
    });
    expect(tx.referenceId).toBe(order.id);
    expect(tx.referenceType).toBe('PAYMENT_ORDER');
  });

  it('SUCCESS after FAILED is rejected without credit', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(ctx.userId, '500', uniqueIdempotencyKey('terminal'));
    const order = await loadOrder(created.body.paymentOrderId);
    const failed = buildSignedCallback(order, PaymentGatewayStatus.FAILED);
    await postCallback(failed.payload, failed.signature);

    const success = buildSignedCallback(order, PaymentGatewayStatus.SUCCESS);
    await postCallback(success.payload, success.signature, 409);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(0);
  });

  it('unauthenticated top-up is rejected', async () => {
    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Idempotency-Key', uniqueIdempotencyKey('no-auth'))
      .send({ amount: '100' })
      .expect(401);
  });
});
