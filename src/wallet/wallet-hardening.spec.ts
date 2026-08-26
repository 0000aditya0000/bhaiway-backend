import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { UsersModule } from '../users/users.module';
import { PaymentOrder } from './entities/payment-order.entity';
import { PaymentOrderStatus } from './enums/payment-order.enums';
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
  MOCK_SIGNATURE_HEADER,
  signMockCallbackPayload,
} from './payment/mock-payment.gateway';
import { PaymentGatewayStatus } from './payment/payment-gateway.types';
import {
  assertSafeTestDatabaseUrl,
  assertWalletBalanceMatchesLots,
  cleanupTestWallet,
  createTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from './test/wallet-test.helpers';
import { WalletLotExpiryService } from './wallet-lot-expiry.service';
import { WalletModule } from './wallet.module';
import { WalletService } from './wallet.service';

const WEBHOOK_SECRET = 'test-webhook-secret-hardening';

describe('Wallet hardening (Phase 4A integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let walletService: WalletService;
  let expiryService: WalletLotExpiryService;
  const tracked: TestWalletContext[] = [];

  beforeAll(async () => {
    process.env.PAYMENT_GATEWAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.PAYMENT_GATEWAY_PROVIDER = 'mock';
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
    jwtService = moduleRef.get(JwtService);
    walletService = moduleRef.get(WalletService);
    expiryService = moduleRef.get(WalletLotExpiryService);
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

  async function spawnWallet() {
    const ctx = await createTestWallet(dataSource);
    tracked.push(ctx);
    return ctx;
  }

  function bearerToken(userId: string) {
    return jwtService.sign({ sub: userId });
  }

  async function createTopUp(userId: string, amount: string, key: string) {
    return request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(userId)}`)
      .set('Idempotency-Key', key)
      .send({ amount })
      .expect(201);
  }

  function buildSignedCallback(order: PaymentOrder, status: PaymentGatewayStatus) {
    const payload = {
      gatewayOrderId: order.gatewayOrderId!,
      amount: order.amount,
      currency: order.currency,
      status,
      reference: uniqueIdempotencyKey('cb'),
    };
    return {
      payload,
      signature: signMockCallbackPayload(payload, WEBHOOK_SECRET),
    };
  }

  it('A: two simultaneous SUCCESS callbacks → one wallet credit', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(
      ctx.userId,
      '500',
      uniqueIdempotencyKey('hard-success'),
    );
    const order = await dataSource.getRepository(PaymentOrder).findOneByOrFail({
      id: created.body.paymentOrderId,
    });
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
    );

    const [a, b] = await Promise.all([
      request(app.getHttpServer())
        .post('/wallet/top-up/callback')
        .set(MOCK_SIGNATURE_HEADER, signature)
        .send(payload),
      request(app.getHttpServer())
        .post('/wallet/top-up/callback')
        .set(MOCK_SIGNATURE_HEADER, signature)
        .send(payload),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          walletId: ctx.walletId,
          transactionType: WalletTransactionType.POINT_PURCHASE,
        },
      }),
    ).toBe(1);
    expect(
      await dataSource.getRepository(WalletPointLot).count({
        where: { walletId: ctx.walletId, sourceType: WalletPointSource.PURCHASED },
      }),
    ).toBe(1);
  });

  it('B: top-up callback + simultaneous booking debit preserves invariants', async () => {
    const ctx = await spawnWallet();
    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount: 1000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('seed'),
    });

    const created = await createTopUp(
      ctx.userId,
      '500',
      uniqueIdempotencyKey('hard-race'),
    );
    const order = await dataSource.getRepository(PaymentOrder).findOneByOrFail({
      id: created.body.paymentOrderId,
    });
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
    );

    await Promise.allSettled([
      request(app.getHttpServer())
        .post('/wallet/top-up/callback')
        .set(MOCK_SIGNATURE_HEADER, signature)
        .send(payload),
      walletService.debitPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 200n,
        idempotencyKey: uniqueIdempotencyKey('debit-race'),
      }),
    ]);

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    expect(BigInt(balance.purchasedAvailable)).toBeGreaterThanOrEqual(0n);
    await assertWalletBalanceMatchesLots(dataSource, ctx.walletId);
  });

  it('C: concurrent same-key top-up create → one payment order', async () => {
    const ctx = await spawnWallet();
    const key = uniqueIdempotencyKey('hard-conc-create');

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

    expect([a.status, b.status]).toEqual([201, 201]);
    expect(
      await dataSource.getRepository(PaymentOrder).count({
        where: { idempotencyKey: key },
      }),
    ).toBe(1);
  });

  it('D: same Idempotency-Key with different amount → 409', async () => {
    const ctx = await spawnWallet();
    const key = uniqueIdempotencyKey('hard-conflict');
    await createTopUp(ctx.userId, '500', key);

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', key)
      .send({ amount: '600' })
      .expect(409);
  });

  it('E: expiry + debit race does not corrupt balances', async () => {
    const ctx = await spawnWallet();
    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount: 500n,
      sourceType: WalletPointSource.PROMOTIONAL,
      idempotencyKey: uniqueIdempotencyKey('exp-race'),
    });
    const lot = await dataSource.getRepository(WalletPointLot).findOneByOrFail({
      walletId: ctx.walletId,
    });
    await dataSource.getRepository(WalletPointLot).update(lot.id, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    await walletService.creditPoints({
      walletId: ctx.walletId,
      userId: ctx.userId,
      amount: 300n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('exp-race-purch'),
    });

    await Promise.allSettled([
      expiryService.expireLotsForWallet(ctx.walletId),
      walletService.debitPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        idempotencyKey: uniqueIdempotencyKey('exp-race-debit'),
      }),
    ]);

    await assertWalletBalanceMatchesLots(dataSource, ctx.walletId);
  });

  it('rejects callback with missing signature', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(
      ctx.userId,
      '500',
      uniqueIdempotencyKey('missing-sig'),
    );
    const order = await dataSource.getRepository(PaymentOrder).findOneByOrFail({
      id: created.body.paymentOrderId,
    });
    const { payload } = buildSignedCallback(order, PaymentGatewayStatus.SUCCESS);

    await request(app.getHttpServer())
      .post('/wallet/top-up/callback')
      .send(payload)
      .expect(400);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(0);
  });

  it('rejects altered callback payload signature mismatch', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(
      ctx.userId,
      '500',
      uniqueIdempotencyKey('altered'),
    );
    const order = await dataSource.getRepository(PaymentOrder).findOneByOrFail({
      id: created.body.paymentOrderId,
    });
    const { payload, signature } = buildSignedCallback(
      order,
      PaymentGatewayStatus.SUCCESS,
    );

    await request(app.getHttpServer())
      .post('/wallet/top-up/callback')
      .set(MOCK_SIGNATURE_HEADER, signature)
      .send({ ...payload, amount: '999' })
      .expect(400);
  });

  it('FAILED callback after SUCCESS cannot alter order', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(
      ctx.userId,
      '500',
      uniqueIdempotencyKey('after-success'),
    );
    const order = await dataSource.getRepository(PaymentOrder).findOneByOrFail({
      id: created.body.paymentOrderId,
    });
    const success = buildSignedCallback(order, PaymentGatewayStatus.SUCCESS);
    await request(app.getHttpServer())
      .post('/wallet/top-up/callback')
      .set(MOCK_SIGNATURE_HEADER, success.signature)
      .send(success.payload)
      .expect(200);

    const failed = buildSignedCallback(order, PaymentGatewayStatus.FAILED);
    await request(app.getHttpServer())
      .post('/wallet/top-up/callback')
      .set(MOCK_SIGNATURE_HEADER, failed.signature)
      .send(failed.payload)
      .expect(409);

    const updated = await dataSource.getRepository(PaymentOrder).findOneByOrFail({
      id: order.id,
    });
    expect(updated.status).toBe(PaymentOrderStatus.SUCCESS);
  });

  it('GET /wallet/top-up/:orderId returns own order without crediting', async () => {
    const ctx = await spawnWallet();
    const created = await createTopUp(
      ctx.userId,
      '500',
      uniqueIdempotencyKey('poll'),
    );

    const response = await request(app.getHttpServer())
      .get(`/wallet/top-up/${created.body.paymentOrderId}`)
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .expect(200);

    expect(response.body.status).toBe(PaymentOrderStatus.PENDING);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(0);
  });

  it('GET /wallet/top-up/:orderId hides other users orders', async () => {
    const userA = await spawnWallet();
    const userB = await spawnWallet();
    const created = await createTopUp(
      userA.userId,
      '500',
      uniqueIdempotencyKey('hide'),
    );

    await request(app.getHttpServer())
      .get(`/wallet/top-up/${created.body.paymentOrderId}`)
      .set('Authorization', `Bearer ${bearerToken(userB.userId)}`)
      .expect(404);
  });
});
