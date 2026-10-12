import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';
import * as crypto from 'crypto';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationType } from '../notifications/enums/notification.enums';
import { UsersModule } from '../users/users.module';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { WalletHoldType } from '../wallet/entities/wallet-hold.entity';
import { WalletPointLot, WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { WalletQueryService } from '../wallet/wallet-query.service';
import {
  getWalletTransactionDisplay,
  WalletTransactionDisplayCategory,
} from '../wallet/wallet-transaction-display.mapper';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { aadhaarVerificationRewardIdempotencyKey } from './aadhaar-verification-reward.constants';
import { UserIdentityVerification } from './entities/user-identity-verification.entity';
import { CashfreeWebhookEvent } from './entities/cashfree-webhook-event.entity';
import {
  IdentityMobileStatus,
  IdentityVerificationStatus,
} from './enums/identity-verification.enums';
import { CashfreeDigiLockerService } from './cashfree/cashfree-digilocker.service';
import { VerificationModule } from './verification.module';

const TEST_CLIENT_SECRET = 'cf_test_secret_key_12345';

describe('Aadhaar verification reward (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let walletService: WalletService;
  let walletQuery: WalletQueryService;
  let cashfreeService: CashfreeDigiLockerService;
  const tracked: TestWalletContext[] = [];

  beforeAll(async () => {
    process.env.CASHFREE_CLIENT_SECRET = TEST_CLIENT_SECRET;
    process.env.CASHFREE_CLIENT_ID = 'cf_test_client_id';
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
        VerificationModule,
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
    authService = moduleRef.get(AuthService);
    walletService = moduleRef.get(WalletService);
    walletQuery = moduleRef.get(WalletQueryService);
    cashfreeService = moduleRef.get(CashfreeDigiLockerService);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await dataSource.getRepository(Notification).delete({
          recipientUserId: ctx.userId,
        });
        await dataSource.getRepository(UserIdentityVerification).delete({
          userId: ctx.userId,
        });
        await cleanupTestWallet(dataSource, ctx);
      }
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  async function createUser() {
    const phone = `+91${Date.now().toString().slice(-10)}${Math.floor(
      Math.random() * 10,
    )}`;
    const login = await authService.loginOrRegisterWithVerifiedIdentity({
      phone,
      verified: true,
    });
    const wallet = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ userId: login.user.id });
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

  async function completeViaRefresh(userId: string, accessToken: string) {
    const vid = `reward_vid_${crypto.randomUUID().slice(0, 8)}`;
    await dataSource.getRepository(UserIdentityVerification).save({
      id: crypto.randomUUID(),
      userId,
      verificationId: vid,
      referenceId: `reward_ref_${vid}`,
      status: IdentityVerificationStatus.PENDING,
      provider: 'CASHFREE',
      verificationType: 'AADHAAR',
      documentType: 'AADHAAR',
    });

    jest.spyOn(cashfreeService, 'getVerificationStatus').mockResolvedValue({
      status: 'AUTHENTICATED',
      verificationId: vid,
      referenceId: `reward_ref_${vid}`,
    });
    jest.spyOn(cashfreeService, 'getAadhaarDocument').mockResolvedValue({
      status: 'VALID',
      uid: 'XXXXXXXX5678',
      name: 'Reward User',
      gender: 'M',
      dob: '1990-01-01',
      mobile: '+919999900000',
    });

    return request(app.getHttpServer())
      .post('/kyc/aadhaar/digilocker/refresh')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  }

  it('does not credit 50 Coins on registration alone', async () => {
    const login = await createUser();
    const balance = await walletQuery.getBalanceForUser(login.user.id);
    expect(balance.balanceCoins).toBe('0');
    expect(balance.withdrawableCoins).toBe('0');

    const rewardTxn = await dataSource.getRepository(WalletTransaction).findOne({
      where: {
        userId: login.user.id,
        idempotencyKey: aadhaarVerificationRewardIdempotencyKey(login.user.id),
      },
    });
    expect(rewardTxn).toBeNull();
  });

  it('credits exactly 50 PROMOTIONAL Coins on Aadhaar VERIFIED', async () => {
    const login = await createUser();
    const res = await completeViaRefresh(login.user.id, login.accessToken);
    expect(res.body.status).toBe(IdentityMobileStatus.VERIFIED);

    const balance = await walletQuery.getBalanceForUser(login.user.id);
    expect(balance.balanceCoins).toBe('50');
    expect(balance.withdrawableCoins).toBe('0');
    expect(balance.buckets.promotional.availableCoins).toBe('50');

    const txn = await dataSource.getRepository(WalletTransaction).findOneByOrFail({
      userId: login.user.id,
      idempotencyKey: aadhaarVerificationRewardIdempotencyKey(login.user.id),
    });
    expect(txn.amount).toBe('50');
    expect(txn.direction).toBe(WalletTransactionDirection.CREDIT);
    expect(txn.transactionType).toBe(WalletTransactionType.PROMOTIONAL_CREDIT);
    expect(txn.pointSource).toBe(WalletPointSource.PROMOTIONAL);
    expect(txn.referenceType).toBe('AADHAAR_VERIFICATION');

    const promoLots = await dataSource.getRepository(WalletPointLot).find({
      where: {
        walletId: tracked[tracked.length - 1].walletId,
        sourceType: WalletPointSource.PROMOTIONAL,
      },
    });
    expect(promoLots.some((l) => l.availableAmount === '50')).toBe(true);

    const display = getWalletTransactionDisplay(txn);
    expect(display.displayTitle).toBe('Aadhaar Verification Reward');
    expect(display.displayCategory).toBe(WalletTransactionDisplayCategory.BONUS);

    const notification = await dataSource.getRepository(Notification).findOne({
      where: {
        recipientUserId: login.user.id,
        type: NotificationType.AADHAAR_VERIFICATION_REWARD,
      },
    });
    expect(notification).toBeTruthy();
  });

  it('does not increase Driver Earnings or withdrawable balance', async () => {
    const login = await createUser();
    await walletService.creditPoints({
      walletId: tracked[tracked.length - 1].walletId,
      userId: login.user.id,
      amount: 100n,
      sourceType: WalletPointSource.DRIVER_EARNED,
      idempotencyKey: uniqueIdempotencyKey('driver-seed'),
    });

    await completeViaRefresh(login.user.id, login.accessToken);
    const balance = await walletQuery.getBalanceForUser(login.user.id);
    expect(balance.balanceCoins).toBe('150');
    expect(balance.withdrawableCoins).toBe('100');
    expect(balance.buckets.driverEarned.availableCoins).toBe('100');
  });

  it('credits only once across duplicate refresh', async () => {
    const login = await createUser();
    await completeViaRefresh(login.user.id, login.accessToken);

    jest.restoreAllMocks();
    await request(app.getHttpServer())
      .post('/kyc/aadhaar/digilocker/refresh')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    const txns = await dataSource.getRepository(WalletTransaction).find({
      where: {
        userId: login.user.id,
        idempotencyKey: aadhaarVerificationRewardIdempotencyKey(login.user.id),
      },
    });
    expect(txns).toHaveLength(1);

    const balance = await walletQuery.getBalanceForUser(login.user.id);
    expect(balance.balanceCoins).toBe('50');
  });

  it('does not credit on FAILED verification', async () => {
    const login = await createUser();
    const vid = `fail_vid_${crypto.randomUUID().slice(0, 8)}`;
    await dataSource.getRepository(UserIdentityVerification).save({
      id: crypto.randomUUID(),
      userId: login.user.id,
      verificationId: vid,
      referenceId: `fail_ref_${vid}`,
      status: IdentityVerificationStatus.PENDING,
      provider: 'CASHFREE',
      verificationType: 'AADHAAR',
      documentType: 'AADHAAR',
    });

    jest.spyOn(cashfreeService, 'getVerificationStatus').mockResolvedValue({
      status: 'FAILED',
      verificationId: vid,
      referenceId: `fail_ref_${vid}`,
    });

    await request(app.getHttpServer())
      .post('/kyc/aadhaar/digilocker/refresh')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    const rewardTxn = await dataSource.getRepository(WalletTransaction).findOne({
      where: {
        userId: login.user.id,
        idempotencyKey: aadhaarVerificationRewardIdempotencyKey(login.user.id),
      },
    });
    expect(rewardTxn).toBeNull();
  });

  it('reward coins can be spent but cannot be withdrawn', async () => {
    const login = await createUser();
    const walletId = tracked[tracked.length - 1].walletId;
    await completeViaRefresh(login.user.id, login.accessToken);

    await walletService.debitPoints({
      walletId,
      userId: login.user.id,
      amount: 20n,
      idempotencyKey: uniqueIdempotencyKey('spend-reward'),
    });

    const afterSpend = await walletQuery.getBalanceForUser(login.user.id);
    expect(afterSpend.balanceCoins).toBe('30');
    expect(afterSpend.withdrawableCoins).toBe('0');

    await expect(
      walletService.createHold({
        walletId,
        amount: 10n,
        holdType: WalletHoldType.WITHDRAWAL,
        referenceType: 'withdrawal-test',
        referenceId: crypto.randomUUID(),
        idempotencyKey: uniqueIdempotencyKey('withdraw-reward'),
      }),
    ).rejects.toThrow();
  });
});
