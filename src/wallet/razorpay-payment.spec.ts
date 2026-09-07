import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createHmac } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { UsersModule } from '../users/users.module';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationType } from '../notifications/enums/notification.enums';
import { PaymentOrder } from './entities/payment-order.entity';
import {
  PaymentWebhookEvent,
  WebhookProcessingStatus,
} from './entities/payment-webhook-event.entity';
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
import { Wallet } from './entities/wallet.entity';
import { PAYMENT_GATEWAY } from './payment/payment-gateway.port';
import { RazorpayPaymentGateway, RAZORPAY_SIGNATURE_HEADER } from './payment/razorpay-payment.gateway';
import { coinsToPaise, paiseToCoins } from './payment/payment-amount.util';
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

const TEST_KEY_ID = 'rzp_test_unitKeyId12345';
const TEST_KEY_SECRET = 'test_key_secret_abcdef123456';
const TEST_WEBHOOK_SECRET = 'test_webhook_secret_987654321';

describe('Razorpay Test Mode Integration (Step 19 Coverage)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let jwtService: JwtService;
  let walletService: WalletService;
  let topUpService: TopUpService;
  let razorpayGateway: RazorpayPaymentGateway;
  const tracked: TestWalletContext[] = [];

  beforeAll(async () => {
    process.env.PAYMENT_GATEWAY_PROVIDER = 'razorpay';
    process.env.RAZORPAY_KEY_ID = TEST_KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = TEST_KEY_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

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

    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    dataSource = moduleRef.get(DataSource);
    await dataSource.getRepository(PaymentWebhookEvent).clear();
    authService = moduleRef.get(AuthService);
    jwtService = moduleRef.get(JwtService);
    walletService = moduleRef.get(WalletService);
    topUpService = moduleRef.get(TopUpService);
    razorpayGateway = moduleRef.get<RazorpayPaymentGateway>(PAYMENT_GATEWAY);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await dataSource.getRepository(PaymentWebhookEvent).clear();
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

  function signCheckout(orderId: string, paymentId: string): string {
    return createHmac('sha256', TEST_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
  }

  function signWebhook(rawBody: string): string {
    return createHmac('sha256', TEST_WEBHOOK_SECRET)
      .update(Buffer.from(rawBody, 'utf8'))
      .digest('hex');
  }

  function mockRazorpayOrderCreation(gatewayOrderId: string) {
    return jest
      .spyOn((razorpayGateway as any).client.orders, 'create')
      .mockImplementation(async (params: any) => ({
        id: gatewayOrderId,
        entity: 'order',
        amount: params.amount,
        amount_paid: 0,
        amount_due: params.amount,
        currency: params.currency,
        receipt: params.receipt,
        status: 'created',
        attempts: 0,
        notes: params.notes,
        created_at: Math.floor(Date.now() / 1000),
      }));
  }

  function mockRazorpayPaymentFetch(paymentId: string, orderId: string, amountPaise: number, status = 'captured') {
    return jest
      .spyOn((razorpayGateway as any).client.payments, 'fetch')
      .mockImplementation(async (id: string) => {
        if (id !== paymentId) {
          throw new Error('Payment not found');
        }
        return {
          id: paymentId,
          entity: 'payment',
          amount: amountPaise,
          currency: 'INR',
          status,
          order_id: orderId,
          method: 'upi',
          captured: status === 'captured',
          created_at: Math.floor(Date.now() / 1000),
        };
      });
  }

  // ---------------------------------------------------------------------------
  // 1 & 2: Order Creation & Unit Conversion
  // ---------------------------------------------------------------------------
  it('1 & 2: Razorpay order creation & INR -> paise conversion', async () => {
    const ctx = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_001';
    const createSpy = mockRazorpayOrderCreation(rzpOrderId);

    const key = uniqueIdempotencyKey('topup-rzp');
    const response = await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', key)
      .send({ amount: '500' })
      .expect(201);

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 50000, // 500 * 100 paise
        currency: 'INR',
      }),
    );

    expect(response.body).toMatchObject({
      amount: '500',
      currency: 'INR',
      status: PaymentOrderStatus.PENDING,
      provider: PaymentOrderProvider.RAZORPAY,
      gatewayOrderId: rzpOrderId,
      keyId: TEST_KEY_ID,
    });

    // Verify amount util conversions
    expect(coinsToPaise('100')).toBe(10000);
    expect(paiseToCoins(10000)).toBe('100');
    expect(paiseToCoins(50000)).toBe('500');
  });

  // ---------------------------------------------------------------------------
  // 3: Zero/negative amount rejection
  // ---------------------------------------------------------------------------
  it('3: Zero and negative amounts are rejected', async () => {
    const ctx = await spawnWallet();

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('zero'))
      .send({ amount: '0' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('neg'))
      .send({ amount: '-50' })
      .expect(400);
  });

  // ---------------------------------------------------------------------------
  // 4 & 12: Valid checkout signature credits wallet
  // ---------------------------------------------------------------------------
  it('4 & 12: Valid checkout signature & captured payment credits wallet', async () => {
    const ctx = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_valid';
    const rzpPaymentId = 'pay_test_rzp_valid';
    mockRazorpayOrderCreation(rzpOrderId);
    mockRazorpayPaymentFetch(rzpPaymentId, rzpOrderId, 30000, 'captured');

    const created = await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('valid-checkout'))
      .send({ amount: '300' })
      .expect(201);

    const signature = signCheckout(rzpOrderId, rzpPaymentId);

    const verifyRes = await request(app.getHttpServer())
      .post('/wallet/top-up/verify')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .send({
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: rzpPaymentId,
        razorpay_signature: signature,
      })
      .expect(201);

    expect(verifyRes.body.status).toBe(PaymentOrderStatus.SUCCESS);
    expect(verifyRes.body.walletTransactionId).toBeDefined();

    // Verify database state: exactly 1 credit, correct balance
    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    expect(balance.purchasedAvailable).toBe('300');

    const txs = await dataSource.getRepository(WalletTransaction).find({
      where: { walletId: ctx.walletId },
    });
    expect(txs).toHaveLength(1);
    expect(txs[0].transactionType).toBe(WalletTransactionType.POINT_PURCHASE);
    expect(txs[0].pointSource).toBe(WalletPointSource.PURCHASED);
    expect(txs[0].amount).toBe('300');
  });

  // ---------------------------------------------------------------------------
  // 5: Invalid checkout signature
  // ---------------------------------------------------------------------------
  it('5: Invalid checkout signature returns 400 and does not credit wallet', async () => {
    const ctx = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_badsig';
    const rzpPaymentId = 'pay_test_rzp_badsig';
    mockRazorpayOrderCreation(rzpOrderId);

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('badsig'))
      .send({ amount: '200' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/wallet/top-up/verify')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .send({
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: rzpPaymentId,
        razorpay_signature: 'deadbeefdeadbeefdeadbeefdeadbeef',
      })
      .expect(400);

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    expect(balance.purchasedAvailable).toBe('0');
  });

  // ---------------------------------------------------------------------------
  // 6: Wrong gateway order ID
  // ---------------------------------------------------------------------------
  it('6: Wrong gateway order ID returns 404', async () => {
    const ctx = await spawnWallet();

    await request(app.getHttpServer())
      .post('/wallet/top-up/verify')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .send({
        razorpay_order_id: 'order_non_existent_123',
        razorpay_payment_id: 'pay_non_existent_123',
        razorpay_signature: 'sig_123',
      })
      .expect(404);
  });

  // ---------------------------------------------------------------------------
  // 7 & 30: Wrong payment ID / Gateway response mismatch
  // ---------------------------------------------------------------------------
  it('7 & 30: Wrong payment ID fails verification without crediting', async () => {
    const ctx = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_wrongpay';
    const rzpPaymentId = 'pay_test_rzp_wrongpay';
    mockRazorpayOrderCreation(rzpOrderId);
    // Razorpay returns an order ID that belongs to someone else
    mockRazorpayPaymentFetch(rzpPaymentId, 'order_different_order_999', 20000, 'captured');

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('wrongpay'))
      .send({ amount: '200' })
      .expect(201);

    const signature = signCheckout(rzpOrderId, rzpPaymentId);

    await request(app.getHttpServer())
      .post('/wallet/top-up/verify')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .send({
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: rzpPaymentId,
        razorpay_signature: signature,
      })
      .expect(400);
  });

  // ---------------------------------------------------------------------------
  // 8: Wrong user
  // ---------------------------------------------------------------------------
  it('8: Another user cannot verify someone else order', async () => {
    const userA = await spawnWallet();
    const userB = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_usera';
    mockRazorpayOrderCreation(rzpOrderId);

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(userA.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('usera'))
      .send({ amount: '200' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/wallet/top-up/verify')
      .set('Authorization', `Bearer ${bearerToken(userB.userId)}`)
      .send({
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: 'pay_test_dummy',
        razorpay_signature: 'sig',
      })
      .expect(404);
  });

  // ---------------------------------------------------------------------------
  // 9 & 10: Wrong amount & wrong currency in webhook
  // ---------------------------------------------------------------------------
  it('9 & 10: Amount and currency mismatch in webhook rejected without credit', async () => {
    const ctx = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_mismatch';
    mockRazorpayOrderCreation(rzpOrderId);

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('mismatch'))
      .send({ amount: '500' })
      .expect(201);

    // Mismatched amount (1000 instead of 500)
    const amountPayload = JSON.stringify({
      id: 'evt_mismatch_amt_1',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_mismatch_1',
            order_id: rzpOrderId,
            amount: 100000, // 1000 coins in paise
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });

    await request(app.getHttpServer())
      .post('/api/payments/gateway/webhook')
      .set(RAZORPAY_SIGNATURE_HEADER, signWebhook(amountPayload))
      .send(amountPayload)
      .expect(422);

    // Mismatched currency (USD instead of INR)
    const currencyPayload = JSON.stringify({
      id: 'evt_mismatch_cur_1',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_mismatch_2',
            order_id: rzpOrderId,
            amount: 50000,
            currency: 'USD',
            status: 'captured',
          },
        },
      },
    });

    await request(app.getHttpServer())
      .post('/api/payments/gateway/webhook')
      .set(RAZORPAY_SIGNATURE_HEADER, signWebhook(currencyPayload))
      .send(currencyPayload)
      .expect(422);

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    expect(balance.purchasedAvailable).toBe('0');
  });

  // ---------------------------------------------------------------------------
  // 11: Authorized payment does not credit wallet
  // ---------------------------------------------------------------------------
  it('11: payment.authorized webhook does NOT credit wallet', async () => {
    const ctx = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_authonly';
    mockRazorpayOrderCreation(rzpOrderId);

    const orderRes = await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('authonly'))
      .send({ amount: '400' })
      .expect(201);

    const webhookPayload = JSON.stringify({
      id: 'evt_auth_1',
      event: 'payment.authorized',
      payload: {
        payment: {
          entity: {
            id: 'pay_auth_1',
            order_id: rzpOrderId,
            amount: 40000,
            currency: 'INR',
            status: 'authorized',
          },
        },
      },
    });

    const res = await request(app.getHttpServer())
      .post('/api/payments/gateway/webhook')
      .set(RAZORPAY_SIGNATURE_HEADER, signWebhook(webhookPayload))
      .send(webhookPayload)
      .expect(200);

    expect(res.body.status).toBe('authorized_acknowledged');

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    expect(balance.purchasedAvailable).toBe('0');

    const order = await dataSource
      .getRepository(PaymentOrder)
      .findOneByOrFail({ id: orderRes.body.paymentOrderId });
    expect(order.status).toBe(PaymentOrderStatus.PENDING);
    expect(order.gatewayStatus).toBe('authorized');
  });

  // ---------------------------------------------------------------------------
  // 13: Payment failed does not credit wallet
  // ---------------------------------------------------------------------------
  it('13: payment.failed marks order FAILED without crediting wallet', async () => {
    const ctx = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_fail';
    mockRazorpayOrderCreation(rzpOrderId);

    const orderRes = await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('fail'))
      .send({ amount: '350' })
      .expect(201);

    const failPayload = JSON.stringify({
      id: 'evt_fail_1',
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: 'pay_fail_1',
            order_id: rzpOrderId,
            amount: 35000,
            currency: 'INR',
            status: 'failed',
          },
        },
      },
    });

    await request(app.getHttpServer())
      .post('/api/payments/gateway/webhook')
      .set(RAZORPAY_SIGNATURE_HEADER, signWebhook(failPayload))
      .send(failPayload)
      .expect(200);

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    expect(balance.purchasedAvailable).toBe('0');

    const order = await dataSource
      .getRepository(PaymentOrder)
      .findOneByOrFail({ id: orderRes.body.paymentOrderId });
    expect(order.status).toBe(PaymentOrderStatus.FAILED);
  });

  // ---------------------------------------------------------------------------
  // 14: Duplicate client verification
  // ---------------------------------------------------------------------------
  it('14: Duplicate client verification returns existing SUCCESS order idempotently', async () => {
    const ctx = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_dupverify';
    const rzpPaymentId = 'pay_test_rzp_dupverify';
    mockRazorpayOrderCreation(rzpOrderId);
    mockRazorpayPaymentFetch(rzpPaymentId, rzpOrderId, 25000, 'captured');

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('dupverify'))
      .send({ amount: '250' })
      .expect(201);

    const signature = signCheckout(rzpOrderId, rzpPaymentId);

    const first = await request(app.getHttpServer())
      .post('/wallet/top-up/verify')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .send({
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: rzpPaymentId,
        razorpay_signature: signature,
      })
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/wallet/top-up/verify')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .send({
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: rzpPaymentId,
        razorpay_signature: signature,
      })
      .expect(201);

    expect(second.body.paymentOrderId).toBe(first.body.paymentOrderId);
    expect(second.body.walletTransactionId).toBe(first.body.walletTransactionId);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 15 & 19: Duplicate webhook & Duplicate webhook event ID
  // ---------------------------------------------------------------------------
  it('15 & 19: Duplicate webhook delivery is deduplicated via event table', async () => {
    const ctx = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_dupwh';
    mockRazorpayOrderCreation(rzpOrderId);

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('dupwh'))
      .send({ amount: '450' })
      .expect(201);

    const webhookPayload = JSON.stringify({
      id: 'evt_dup_test_1',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_dup_test_1',
            order_id: rzpOrderId,
            amount: 45000,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });

    const first = await request(app.getHttpServer())
      .post('/api/payments/gateway/webhook')
      .set(RAZORPAY_SIGNATURE_HEADER, signWebhook(webhookPayload))
      .send(webhookPayload)
      .expect(200);

    expect(first.body.status).toBe('captured_and_credited');

    const second = await request(app.getHttpServer())
      .post('/api/payments/gateway/webhook')
      .set(RAZORPAY_SIGNATURE_HEADER, signWebhook(webhookPayload))
      .send(webhookPayload)
      .expect(200);

    expect(second.body.status).toBe('already_processed');

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 16: Callback then webhook
  // ---------------------------------------------------------------------------
  it('16: Callback then webhook race: webhook is safe no-op', async () => {
    const ctx = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_cb_first';
    const rzpPaymentId = 'pay_test_rzp_cb_first';
    mockRazorpayOrderCreation(rzpOrderId);
    mockRazorpayPaymentFetch(rzpPaymentId, rzpOrderId, 15000, 'captured');

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('cb-first'))
      .send({ amount: '150' })
      .expect(201);

    // 1. Client callback arrives first
    const signature = signCheckout(rzpOrderId, rzpPaymentId);
    await request(app.getHttpServer())
      .post('/wallet/top-up/verify')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .send({
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: rzpPaymentId,
        razorpay_signature: signature,
      })
      .expect(201);

    // 2. Webhook arrives second
    const webhookPayload = JSON.stringify({
      id: 'evt_cb_then_wh_1',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: rzpPaymentId,
            order_id: rzpOrderId,
            amount: 15000,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });

    await request(app.getHttpServer())
      .post('/api/payments/gateway/webhook')
      .set(RAZORPAY_SIGNATURE_HEADER, signWebhook(webhookPayload))
      .send(webhookPayload)
      .expect(200);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 17: Webhook then callback
  // ---------------------------------------------------------------------------
  it('17: Webhook then callback race: callback returns existing SUCCESS result', async () => {
    const ctx = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_wh_first';
    const rzpPaymentId = 'pay_test_rzp_wh_first';
    mockRazorpayOrderCreation(rzpOrderId);
    mockRazorpayPaymentFetch(rzpPaymentId, rzpOrderId, 18000, 'captured');

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('wh-first'))
      .send({ amount: '180' })
      .expect(201);

    // 1. Webhook arrives first
    const webhookPayload = JSON.stringify({
      id: 'evt_wh_then_cb_1',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: rzpPaymentId,
            order_id: rzpOrderId,
            amount: 18000,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });

    await request(app.getHttpServer())
      .post('/api/payments/gateway/webhook')
      .set(RAZORPAY_SIGNATURE_HEADER, signWebhook(webhookPayload))
      .send(webhookPayload)
      .expect(200);

    // 2. Client verification arrives second
    const signature = signCheckout(rzpOrderId, rzpPaymentId);
    const cbRes = await request(app.getHttpServer())
      .post('/wallet/top-up/verify')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .send({
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: rzpPaymentId,
        razorpay_signature: signature,
      })
      .expect(201);

    expect(cbRes.body.status).toBe(PaymentOrderStatus.SUCCESS);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 18: Concurrent callback + webhook
  // ---------------------------------------------------------------------------
  it('18: Concurrent callback and webhook race credits wallet exactly once', async () => {
    const ctx = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_concurrent';
    const rzpPaymentId = 'pay_test_rzp_concurrent';
    mockRazorpayOrderCreation(rzpOrderId);
    mockRazorpayPaymentFetch(rzpPaymentId, rzpOrderId, 22000, 'captured');

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('concurrent'))
      .send({ amount: '220' })
      .expect(201);

    const signature = signCheckout(rzpOrderId, rzpPaymentId);
    const webhookPayload = JSON.stringify({
      id: 'evt_concurrent_1',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: rzpPaymentId,
            order_id: rzpOrderId,
            amount: 22000,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });

    const [cbRes, whRes] = await Promise.all([
      request(app.getHttpServer())
        .post('/wallet/top-up/verify')
        .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
        .send({
          razorpay_order_id: rzpOrderId,
          razorpay_payment_id: rzpPaymentId,
          razorpay_signature: signature,
        }),
      request(app.getHttpServer())
        .post('/api/payments/gateway/webhook')
        .set(RAZORPAY_SIGNATURE_HEADER, signWebhook(webhookPayload))
        .send(webhookPayload),
    ]);

    expect(cbRes.status).toBe(201);
    expect(whRes.status).toBe(200);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: ctx.walletId },
      }),
    ).toBe(1);

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    expect(balance.purchasedAvailable).toBe('220');
  });

  // ---------------------------------------------------------------------------
  // 20 & 21: Invalid & Malformed webhook
  // ---------------------------------------------------------------------------
  it('20 & 21: Invalid webhook signature & malformed payload rejected with 400', async () => {
    // Bad signature
    await request(app.getHttpServer())
      .post('/api/payments/gateway/webhook')
      .set(RAZORPAY_SIGNATURE_HEADER, 'invalid_sig_hex_1234567890abcdef')
      .send(JSON.stringify({ event: 'payment.captured' }))
      .expect(400);

    // Missing signature
    await request(app.getHttpServer())
      .post('/api/payments/gateway/webhook')
      .send(JSON.stringify({ event: 'payment.captured' }))
      .expect(400);
  });

  // ---------------------------------------------------------------------------
  // 22: Unknown webhook event
  // ---------------------------------------------------------------------------
  it('22: Unknown webhook event returns 200 with ignored status', async () => {
    const payload = JSON.stringify({
      id: 'evt_unknown_1',
      event: 'settlement.processed',
      payload: { settlement: { id: 'set_1' } },
    });

    const res = await request(app.getHttpServer())
      .post('/api/payments/gateway/webhook')
      .set(RAZORPAY_SIGNATURE_HEADER, signWebhook(payload))
      .send(payload)
      .expect(200);

    expect(res.body.status).toBe('ignored');
  });

  // ---------------------------------------------------------------------------
  // 23: Wallet credit failure rolls back transaction
  // ---------------------------------------------------------------------------
  it('23: Wallet credit failure rolls back payment transaction to PENDING', async () => {
    const ctx = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_rollback';
    const rzpPaymentId = 'pay_test_rzp_rollback';
    mockRazorpayOrderCreation(rzpOrderId);
    mockRazorpayPaymentFetch(rzpPaymentId, rzpOrderId, 10000, 'captured');

    const created = await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('rollback'))
      .send({ amount: '100' })
      .expect(201);

    const creditSpy = jest
      .spyOn(walletService, 'creditPointsInTransaction')
      .mockRejectedValueOnce(new Error('Simulated wallet failure'));

    const signature = signCheckout(rzpOrderId, rzpPaymentId);

    await request(app.getHttpServer())
      .post('/wallet/top-up/verify')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .send({
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: rzpPaymentId,
        razorpay_signature: signature,
      })
      .expect(500);

    creditSpy.mockRestore();

    const order = await dataSource
      .getRepository(PaymentOrder)
      .findOneByOrFail({ id: created.body.paymentOrderId });
    expect(order.status).toBe(PaymentOrderStatus.PENDING);
    expect(order.walletTransactionId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 24: Existing SUCCESS payment is safe to retry
  // ---------------------------------------------------------------------------
  it('24: Retrying createTopUp after SUCCESS returns existing SUCCESS order', async () => {
    const ctx = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_retrysuccess';
    const rzpPaymentId = 'pay_test_rzp_retrysuccess';
    mockRazorpayOrderCreation(rzpOrderId);
    mockRazorpayPaymentFetch(rzpPaymentId, rzpOrderId, 20000, 'captured');

    const key = uniqueIdempotencyKey('retrysuccess');
    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', key)
      .send({ amount: '200' })
      .expect(201);

    const signature = signCheckout(rzpOrderId, rzpPaymentId);
    await request(app.getHttpServer())
      .post('/wallet/top-up/verify')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .send({
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: rzpPaymentId,
        razorpay_signature: signature,
      })
      .expect(201);

    // Now user re-posts with same key
    const retryRes = await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', key)
      .send({ amount: '200' })
      .expect(201);

    expect(retryRes.body.status).toBe(PaymentOrderStatus.SUCCESS);
  });

  // ---------------------------------------------------------------------------
  // 25: Notification outbox is created once
  // ---------------------------------------------------------------------------
  it('25: Exactly one WALLET_CREDITED notification outbox record is created', async () => {
    const ctx = await spawnWallet();
    const rzpOrderId = 'order_test_rzp_notify';
    const rzpPaymentId = 'pay_test_rzp_notify';
    mockRazorpayOrderCreation(rzpOrderId);
    mockRazorpayPaymentFetch(rzpPaymentId, rzpOrderId, 30000, 'captured');

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('notify'))
      .send({ amount: '300' })
      .expect(201);

    const signature = signCheckout(rzpOrderId, rzpPaymentId);
    await request(app.getHttpServer())
      .post('/wallet/top-up/verify')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .send({
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: rzpPaymentId,
        razorpay_signature: signature,
      })
      .expect(201);

    const notifications = await dataSource.getRepository(Notification).find({
      where: {
        recipientUserId: ctx.userId,
        type: NotificationType.WALLET_CREDITED,
      },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('Money added to your wallet');
    expect(notifications[0].body).toContain('300');
  });

  // ---------------------------------------------------------------------------
  // 26: PaymentOrder gatewayPaymentId uniqueness
  // ---------------------------------------------------------------------------
  it('26: gatewayPaymentId uniqueness is enforced in database', async () => {
    const ctx = await spawnWallet();
    const duplicatePaymentId = 'pay_duplicate_constraint_test';

    const order1 = dataSource.getRepository(PaymentOrder).create({
      userId: ctx.userId,
      walletId: ctx.walletId,
      amount: '100',
      currency: 'INR',
      provider: PaymentOrderProvider.RAZORPAY,
      gatewayOrderId: 'order_dup_1',
      gatewayPaymentId: duplicatePaymentId,
      status: PaymentOrderStatus.SUCCESS,
    });
    await dataSource.getRepository(PaymentOrder).save(order1);

    const order2 = dataSource.getRepository(PaymentOrder).create({
      userId: ctx.userId,
      walletId: ctx.walletId,
      amount: '100',
      currency: 'INR',
      provider: PaymentOrderProvider.RAZORPAY,
      gatewayOrderId: 'order_dup_2',
      gatewayPaymentId: duplicatePaymentId,
      status: PaymentOrderStatus.SUCCESS,
    });

    await expect(
      dataSource.getRepository(PaymentOrder).save(order2),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 27: PaymentOrder idempotency with different amount fails
  // ---------------------------------------------------------------------------
  it('27: Same idempotency key with different amount returns 409', async () => {
    const ctx = await spawnWallet();
    const key = uniqueIdempotencyKey('diff-amt');
    mockRazorpayOrderCreation('order_diff_1');

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', key)
      .send({ amount: '100' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', key)
      .send({ amount: '200' })
      .expect(409);
  });

  // ---------------------------------------------------------------------------
  // 28 & 29: Razorpay API failure / timeout during order creation
  // ---------------------------------------------------------------------------
  it('28 & 29: Razorpay API failure records FAILED order without crediting wallet', async () => {
    const ctx = await spawnWallet();
    jest
      .spyOn((razorpayGateway as any).client.orders, 'create')
      .mockRejectedValueOnce(new Error('Razorpay Gateway Timeout'));

    const key = uniqueIdempotencyKey('rzp-fail');
    await request(app.getHttpServer())
      .post('/wallet/top-up')
      .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
      .set('Idempotency-Key', key)
      .send({ amount: '100' })
      .expect(500);

    const order = await dataSource.getRepository(PaymentOrder).findOneByOrFail({
      idempotencyKey: key,
    });
    expect(order.status).toBe(PaymentOrderStatus.FAILED);
    expect(order.failureReason).toContain('Timeout');

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: ctx.walletId });
    expect(balance.purchasedAvailable).toBe('0');
  });
});
