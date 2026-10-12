import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationType } from '../notifications/enums/notification.enums';
import { UsersModule } from '../users/users.module';
import { UserProfile } from '../users/entities/user-profile.entity';
import { User } from '../users/entities/user.entity';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import {
  WalletPointLot,
  WalletPointSource,
} from '../wallet/entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
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
import { Referral } from './entities/referral.entity';
import {
  REFERRAL_REFERENCE_TYPE,
  REFERRAL_REWARD_COINS,
  ReferralStatus,
  referralRewardReferredIdempotencyKey,
  referralRewardReferrerIdempotencyKey,
} from './enums/referral.enums';
import {
  ReferralCodeInvalidError,
  SelfReferralNotAllowedError,
} from './errors/referral.errors';
import { ReferralService } from './referral.service';
import { ReferralsModule } from './referrals.module';

describe('Referral system (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let referralService: ReferralService;
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
        ReferralsModule,
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
    referralService = moduleRef.get(ReferralService);
    walletService = moduleRef.get(WalletService);
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await dataSource.getRepository(Notification).delete({
          recipientUserId: ctx.userId,
        });
        await cleanupTestWallet(dataSource, ctx);
      }
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  async function trackUser(userId: string, phone: string): Promise<TestWalletContext> {
    const wallet = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ userId });
    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    const ctx: TestWalletContext = {
      userId,
      walletId: wallet.id,
      balanceId: balance.id,
      phone,
    };
    tracked.push(ctx);
    return ctx;
  }

  async function registerNewUser(referralCode?: string) {
    const phone = `+91${Date.now().toString().slice(-10)}${Math.floor(
      Math.random() * 10,
    )}`;
    const login = await authService.loginOrRegisterWithVerifiedIdentity({
      phone,
      verified: true,
      referralCode,
    });
    await trackUser(login.user.id, phone);
    return login;
  }

  it('assigns a unique uppercase BHW referral code to new users', async () => {
    const login = await registerNewUser();
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: login.user.id });

    expect(user.referralCode).toBeTruthy();
    expect(user.referralCode!.startsWith('BHW')).toBe(true);
    expect(user.referralCode).toBe(user.referralCode!.toUpperCase());

    const again = await referralService.ensureUserReferralCode(login.user.id);
    expect(again).toBe(user.referralCode);
  });

  it('registers without referralCode (unchanged behavior)', async () => {
    const login = await registerNewUser();
    const referrals = await dataSource.getRepository(Referral).find({
      where: { referredUserId: login.user.id },
    });
    expect(referrals).toHaveLength(0);

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({
        walletId: (
          await dataSource
            .getRepository(Wallet)
            .findOneByOrFail({ userId: login.user.id })
        ).id,
      });
    expect(balance.promotionalAvailable).toBe('0');
  });

  it('credits both users 50 PROMOTIONAL coins on valid referral registration', async () => {
    const referrerLogin = await registerNewUser();
    const referrer = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: referrerLogin.user.id });

    await dataSource.getRepository(UserProfile).save(
      dataSource.getRepository(UserProfile).create({
        userId: referrer.id,
        firstName: 'Ref',
        lastName: 'Errer',
        displayName: 'Referrer',
        gender: null,
        dateOfBirth: null,
        profilePhoto: null,
      }),
    );

    const referredLogin = await registerNewUser(referrer.referralCode!);

    const referral = await dataSource.getRepository(Referral).findOneByOrFail({
      referredUserId: referredLogin.user.id,
    });
    expect(referral.referrerUserId).toBe(referrer.id);
    expect(referral.status).toBe(ReferralStatus.REWARDED);
    expect(referral.rewardCoins).toBe('50');
    expect(referral.referralCode).toBe(referrer.referralCode);

    const referrerWallet = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ userId: referrer.id });
    const referredWallet = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ userId: referredLogin.user.id });

    const referrerBal = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: referrerWallet.id });
    const referredBal = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: referredWallet.id });

    expect(referrerBal.promotionalAvailable).toBe('50');
    expect(referredBal.promotionalAvailable).toBe('50');
    expect(referrerBal.driverEarnedAvailable).toBe('0');
    expect(referredBal.driverEarnedAvailable).toBe('0');

    const txns = await dataSource.getRepository(WalletTransaction).find({
      where: { referenceType: REFERRAL_REFERENCE_TYPE, referenceId: referral.id },
    });
    expect(txns).toHaveLength(2);
    for (const txn of txns) {
      expect(txn.transactionType).toBe(WalletTransactionType.PROMOTIONAL_CREDIT);
      expect(txn.amount).toBe('50');
      const display = getWalletTransactionDisplay(txn);
      expect(display.displayTitle).toBe('Referral Reward');
      expect(display.displayCategory).toBe(
        WalletTransactionDisplayCategory.BONUS,
      );
    }

    const lots = await dataSource.getRepository(WalletPointLot).find({
      where: [
        { walletId: referrerWallet.id, sourceType: WalletPointSource.PROMOTIONAL },
        { walletId: referredWallet.id, sourceType: WalletPointSource.PROMOTIONAL },
      ],
    });
    expect(lots.length).toBeGreaterThanOrEqual(2);

    const notifyReferrer = await dataSource.getRepository(Notification).findOne({
      where: {
        recipientUserId: referrer.id,
        type: NotificationType.REFERRAL_REWARD_REFERRER,
      },
    });
    const notifyReferred = await dataSource.getRepository(Notification).findOne({
      where: {
        recipientUserId: referredLogin.user.id,
        type: NotificationType.REFERRAL_REWARD_REFERRED,
      },
    });
    expect(notifyReferrer).toBeTruthy();
    expect(notifyReferred).toBeTruthy();
    expect(notifyReferrer!.body).toContain('50 Coins');
    expect(notifyReferred!.body).toContain('50 Coins');
  });

  it('normalizes lowercase / padded referral codes', async () => {
    const referrerLogin = await registerNewUser();
    const referrer = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: referrerLogin.user.id });

    const code = referrer.referralCode!;
    const referred = await registerNewUser(` ${code.toLowerCase()} `);
    const referral = await dataSource.getRepository(Referral).findOneByOrFail({
      referredUserId: referred.user.id,
    });
    expect(referral.referrerUserId).toBe(referrer.id);
  });

  it('rejects invalid referral code without creating the user', async () => {
    const phone = `+91${Date.now().toString().slice(-10)}9`;
    await expect(
      authService.loginOrRegisterWithVerifiedIdentity({
        phone,
        verified: true,
        referralCode: 'BHWNOTEXIST',
      }),
    ).rejects.toBeInstanceOf(ReferralCodeInvalidError);

    const user = await dataSource.getRepository(User).findOne({ where: { phone } });
    expect(user).toBeNull();
  });

  it('ignores referralCode for existing users (no second reward)', async () => {
    const referrerLogin = await registerNewUser();
    const referrer = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: referrerLogin.user.id });

    const existingLogin = await registerNewUser();
    const before = await dataSource.getRepository(Referral).count({
      where: { referredUserId: existingLogin.user.id },
    });
    expect(before).toBe(0);

    await authService.loginOrRegisterWithVerifiedIdentity({
      phone: existingLogin.user.phone,
      verified: true,
      referralCode: referrer.referralCode!,
    });

    const after = await dataSource.getRepository(Referral).count({
      where: { referredUserId: existingLogin.user.id },
    });
    expect(after).toBe(0);

    const wallet = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ userId: existingLogin.user.id });
    const bal = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(bal.promotionalAvailable).toBe('0');
  });

  it('rejects self-referral in reward application', async () => {
    const login = await registerNewUser();
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: login.user.id });

    await expect(
      dataSource.transaction(async (manager) =>
        referralService.applyReferralRewardsInTransaction(manager, {
          referrer: user,
          referredUserId: user.id,
          referralCode: user.referralCode!,
        }),
      ),
    ).rejects.toBeInstanceOf(SelfReferralNotAllowedError);
  });

  it('idempotent wallet keys do not double-credit', async () => {
    const referrerLogin = await registerNewUser();
    const referrer = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: referrerLogin.user.id });
    const referredLogin = await registerNewUser(referrer.referralCode!);
    const referral = await dataSource.getRepository(Referral).findOneByOrFail({
      referredUserId: referredLogin.user.id,
    });

    const referrerWallet = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ userId: referrer.id });

    await walletService.creditPoints({
      walletId: referrerWallet.id,
      userId: referrer.id,
      amount: REFERRAL_REWARD_COINS,
      sourceType: WalletPointSource.PROMOTIONAL,
      referenceType: REFERRAL_REFERENCE_TYPE,
      referenceId: referral.id,
      idempotencyKey: referralRewardReferrerIdempotencyKey(referral.id),
      suppressWalletCreditNotification: true,
    });

    const bal = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: referrerWallet.id });
    expect(bal.promotionalAvailable).toBe('50');

    const txnCount = await dataSource.getRepository(WalletTransaction).count({
      where: { idempotencyKey: referralRewardReferrerIdempotencyKey(referral.id) },
    });
    expect(txnCount).toBe(1);

    const referredKeyCount = await dataSource
      .getRepository(WalletTransaction)
      .count({
        where: {
          idempotencyKey: referralRewardReferredIdempotencyKey(referral.id),
        },
      });
    expect(referredKeyCount).toBe(1);
  });

  it('referral coins are not withdrawable (driver earned unchanged)', async () => {
    const referrerLogin = await registerNewUser();
    const referrer = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: referrerLogin.user.id });
    await registerNewUser(referrer.referralCode!);

    const wallet = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ userId: referrer.id });
    const bal = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });

    expect(bal.promotionalAvailable).toBe('50');
    expect(bal.driverEarnedAvailable).toBe('0');

    // Fund driver earnings separately — withdrawable path still DRIVER_EARNED only.
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: referrer.id,
      amount: 100n,
      sourceType: WalletPointSource.DRIVER_EARNED,
      idempotencyKey: uniqueIdempotencyKey('referral-wd-earning'),
    });
    const after = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(after.driverEarnedAvailable).toBe('100');
    expect(after.promotionalAvailable).toBe('50');
  });

  it('GET /referrals/summary and list expose code and non-sensitive referred users', async () => {
    const referrerLogin = await registerNewUser();
    const referrer = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: referrerLogin.user.id });

    const referredLogin = await registerNewUser(referrer.referralCode!);
    await dataSource.getRepository(UserProfile).save(
      dataSource.getRepository(UserProfile).create({
        userId: referredLogin.user.id,
        firstName: 'Rahul',
        lastName: 'Test',
        displayName: 'Rahul',
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example/p.jpg',
      }),
    );

    const summaryRes = await request(app.getHttpServer())
      .get('/referrals/summary')
      .set('Authorization', `Bearer ${referrerLogin.accessToken}`)
      .expect(200);

    expect(summaryRes.body.referralCode).toBe(referrer.referralCode);
    expect(summaryRes.body.totalReferrals).toBe(1);
    expect(summaryRes.body.totalCoinsEarned).toBe('50');

    const listRes = await request(app.getHttpServer())
      .get('/referrals?page=1&limit=20')
      .set('Authorization', `Bearer ${referrerLogin.accessToken}`)
      .expect(200);

    expect(listRes.body.total).toBe(1);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0].referredUser.name).toBe('Rahul');
    expect(listRes.body.items[0].referredUser.profilePhoto).toBe(
      'https://cdn.example/p.jpg',
    );
    expect(listRes.body.items[0].referredUser).not.toHaveProperty('phone');
    expect(listRes.body.items[0].referredUser).not.toHaveProperty('email');

    // Another user cannot see this list as their own.
    const other = await registerNewUser();
    const otherList = await request(app.getHttpServer())
      .get('/referrals')
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(200);
    expect(otherList.body.total).toBe(0);
  });

  it('does not create multi-level rewards (A→B→C does not pay A for C)', async () => {
    const a = await registerNewUser();
    const aUser = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: a.user.id });
    const b = await registerNewUser(aUser.referralCode!);
    const bUser = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: b.user.id });
    await registerNewUser(bUser.referralCode!);

    const aReferrals = await dataSource.getRepository(Referral).count({
      where: { referrerUserId: a.user.id },
    });
    const bReferrals = await dataSource.getRepository(Referral).count({
      where: { referrerUserId: b.user.id },
    });
    expect(aReferrals).toBe(1);
    expect(bReferrals).toBe(1);

    const aWallet = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ userId: a.user.id });
    const aBal = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: aWallet.id });
    expect(aBal.promotionalAvailable).toBe('50');
  });
});
