import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { SmtpMailService } from '../email/smtp-mail.service';
import { EmailVerificationModule } from '../email-verification/email-verification.module';
import { EmailVerificationOtp } from '../email-verification/entities/email-verification-otp.entity';
import { EmailOtpPurpose } from '../email-verification/enums/email-otp-purpose.enum';
import {
  EMAIL_OTP_MAX_ATTEMPTS,
  EMAIL_OTP_MAX_SENDS_PER_HOUR,
} from '../email-verification/email-verification.constants';
import { RatingsModule } from '../ratings/ratings.module';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';
import { WalletModule } from '../wallet/wallet.module';
import { CorporateIdentityModule } from './corporate-identity.module';
import { CorporateIdentityVerification } from './entities/corporate-identity-verification.entity';
import { CorporateIdentityStatus } from './enums/corporate-identity-status.enum';

describe('Corporate identity verification (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  const tracked: TestWalletContext[] = [];
  const sendEmail = jest.fn().mockResolvedValue(undefined);

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
        RatingsModule,
        EmailVerificationModule,
        CorporateIdentityModule,
      ],
    })
      .overrideProvider(OTP_PROVIDER)
      .useValue({
        verifyAccessToken: jest
          .fn()
          .mockRejectedValue(new Msg91ResponseFormatError()),
      })
      .overrideProvider(SmtpMailService)
      .useValue({
        sendEmail,
        getFromAddress: () => 'BhaiWay <alerts@kodenzolabs.in>',
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
  });

  afterEach(async () => {
    sendEmail.mockReset();
    sendEmail.mockResolvedValue(undefined);
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await dataSource.getRepository(EmailVerificationOtp).delete({
          userId: ctx.userId,
        });
        await dataSource.getRepository(CorporateIdentityVerification).delete({
          userId: ctx.userId,
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

  async function createUser() {
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

  function extractOtpFromSend(callIndex = 0): string {
    const html = String(sendEmail.mock.calls[callIndex][0].html);
    const match = html.match(/\b(\d{4})\b/);
    expect(match).not.toBeNull();
    return match![1];
  }

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .send({ email: 'employee@company.com' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/corporate-identity/verify')
      .send({ email: 'employee@company.com', otp: '1234' })
      .expect(401);
    await request(app.getHttpServer())
      .get('/corporate-identity/status')
      .expect(401);
  });

  it('sends a hashed corporate OTP via existing SMTP and never returns OTP', async () => {
    const login = await createUser();
    const email = `employee${Date.now()}@company.com`;

    const res = await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(200);

    expect(res.body.status).toBe(CorporateIdentityStatus.OTP_PENDING);
    expect(res.body.email).toBe(email);
    expect(JSON.stringify(res.body)).not.toMatch(/\b\d{4}\b/);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        to: email,
        subject: 'Verify your BhaiWay corporate identity',
      }),
    );

    const stored = await dataSource
      .getRepository(EmailVerificationOtp)
      .findOneByOrFail({
        userId: login.user.id,
        purpose: EmailOtpPurpose.CORPORATE_IDENTITY,
      });
    const otp = extractOtpFromSend();
    expect(stored.otpHash).not.toContain(otp);
    expect(stored.purpose).toBe(EmailOtpPurpose.CORPORATE_IDENTITY);
    expect(stored.email).toBe(email);
  });

  it('verifies a correct corporate OTP and marks VERIFIED', async () => {
    const login = await createUser();
    const email = `employee${Date.now()}@kodenzolabs.in`;

    await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(200);
    const otp = extractOtpFromSend();

    const res = await request(app.getHttpServer())
      .post('/corporate-identity/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email, otp })
      .expect(200);

    expect(res.body.status).toBe(CorporateIdentityStatus.VERIFIED);
    expect(res.body.email).toBe(email);
    expect(res.body.verifiedAt).toBeTruthy();

    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: login.user.id });
    expect(user.emailVerified).toBe(false);
    expect(user.email).toBeNull();

    const status = await request(app.getHttpServer())
      .get('/corporate-identity/status')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);
    expect(status.body).toEqual({
      status: CorporateIdentityStatus.VERIFIED,
      email,
      verifiedAt: res.body.verifiedAt,
    });
  });

  it('rejects a wrong corporate OTP', async () => {
    const login = await createUser();
    const email = `employee${Date.now()}@tcs.com`;

    await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(200);

    const wrong = await request(app.getHttpServer())
      .post('/corporate-identity/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email, otp: '0000' })
      .expect(400);
    expect(wrong.body.code).toBe('EMAIL_VERIFICATION_INVALID');
  });

  it('rejects an expired corporate OTP', async () => {
    const login = await createUser();
    const email = `employee${Date.now()}@tcs.com`;
    const repo = dataSource.getRepository(EmailVerificationOtp);

    await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(200);
    const otp = extractOtpFromSend();

    const fresh = await repo.findOneOrFail({
      where: {
        userId: login.user.id,
        purpose: EmailOtpPurpose.CORPORATE_IDENTITY,
        invalidatedAt: IsNull(),
      },
    });
    await repo.update(
      { id: fresh.id },
      { expiresAt: new Date(Date.now() - 1_000) },
    );

    const expired = await request(app.getHttpServer())
      .post('/corporate-identity/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email, otp })
      .expect(400);
    expect(expired.body.code).toBe('EMAIL_VERIFICATION_EXPIRED');
  });

  it('rejects corporate OTP after max attempts', async () => {
    const login = await createUser();
    const email = `employee${Date.now()}@tcs.com`;
    const repo = dataSource.getRepository(EmailVerificationOtp);

    await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(200);
    const attemptOtp = extractOtpFromSend();

    const attemptRecord = await repo.findOneOrFail({
      where: {
        userId: login.user.id,
        purpose: EmailOtpPurpose.CORPORATE_IDENTITY,
        invalidatedAt: IsNull(),
      },
    });
    await repo.update(
      { id: attemptRecord.id },
      { attempts: EMAIL_OTP_MAX_ATTEMPTS },
    );

    const attempts = await request(app.getHttpServer())
      .post('/corporate-identity/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email, otp: attemptOtp })
      .expect(429);
    expect(attempts.body.code).toBe('EMAIL_VERIFICATION_ATTEMPTS_EXCEEDED');
  });

  it('enforces resend cooldown across corporate email changes', async () => {
    const login = await createUser();
    const emailA = `a${Date.now()}@company.com`;
    const emailB = `b${Date.now()}@startup.co`;

    await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: emailA })
      .expect(200);

    const cooldown = await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: emailB })
      .expect(429);
    expect(cooldown.body.code).toBe('EMAIL_VERIFICATION_COOLDOWN');
  });

  it('enforces hourly corporate send limits across email changes', async () => {
    const login = await createUser();
    const emailB = `b${Date.now()}@startup.co`;
    const repo = dataSource.getRepository(EmailVerificationOtp);
    const now = Date.now();

    for (let i = 0; i < EMAIL_OTP_MAX_SENDS_PER_HOUR; i += 1) {
      await repo.save(
        repo.create({
          userId: login.user.id,
          email: `seed${i}@company.com`,
          purpose: EmailOtpPurpose.CORPORATE_IDENTITY,
          otpHash: `v1$seed${i}$hash`,
          expiresAt: new Date(now + 60_000),
          attempts: 0,
          maxAttempts: 5,
          sentAt: new Date(now - 70_000 - i * 1000),
          verifiedAt: null,
          invalidatedAt: new Date(now - 70_000),
        }),
      );
    }

    const limited = await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: emailB })
      .expect(429);
    expect(limited.body.code).toBe('EMAIL_VERIFICATION_RATE_LIMITED');
  });

  it.each([
    'gmail.com',
    'yahoo.com',
    'outlook.com',
    'hotmail.com',
    'icloud.com',
    'proton.me',
    'protonmail.com',
    'zoho.com',
    'mail.gmail.com',
  ])(
    'rejects blocked domain %s without generating OTP or consuming limits',
    async (domain) => {
      const login = await createUser();
      const before = await dataSource.getRepository(EmailVerificationOtp).count({
        where: {
          userId: login.user.id,
          purpose: EmailOtpPurpose.CORPORATE_IDENTITY,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/corporate-identity/send')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ email: `employee@${domain}` })
        .expect(422);

      expect(res.body.code).toBe('CORPORATE_EMAIL_NOT_ALLOWED');
      expect(sendEmail).not.toHaveBeenCalled();
      const after = await dataSource.getRepository(EmailVerificationOtp).count({
        where: {
          userId: login.user.id,
          purpose: EmailOtpPurpose.CORPORATE_IDENTITY,
        },
      });
      expect(after).toBe(before);

      const record = await dataSource
        .getRepository(CorporateIdentityVerification)
        .findOne({ where: { userId: login.user.id } });
      expect(record == null || record.status === CorporateIdentityStatus.NOT_VERIFIED).toBe(
        true,
      );
    },
  );

  it('allows evilgmail.com (not a gmail.com label match) and normalizes email', async () => {
    const login = await createUser();

    const res = await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: '  Employee@EVILGMAIL.COM ' })
      .expect(200);

    expect(res.body.email).toBe('employee@evilgmail.com');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe('employee@evilgmail.com');
  });

  it('keeps personal email verification working for gmail.com', async () => {
    const login = await createUser();
    const email = `personal${Date.now()}@gmail.com`;

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada', email })
      .expect(201);

    await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(200);

    const otp = extractOtpFromSend();
    await request(app.getHttpServer())
      .post('/users/email-verification/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ otp })
      .expect(200);

    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: login.user.id });
    expect(user.emailVerified).toBe(true);
    expect(user.email).toBe(email);
  });

  it('does not allow personal OTP to verify corporate identity or vice versa', async () => {
    const login = await createUser();
    const personal = `personal${Date.now()}@gmail.com`;
    const corporate = `corp${Date.now()}@company.com`;

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada', email: personal })
      .expect(201);

    await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: personal })
      .expect(200);
    const personalOtp = extractOtpFromSend();

    sendEmail.mockClear();
    await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: corporate })
      .expect(200);
    const corporateOtp = extractOtpFromSend();

    const crossCorporate = await request(app.getHttpServer())
      .post('/corporate-identity/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: corporate, otp: personalOtp })
      .expect(400);
    expect(crossCorporate.body.code).toBe('EMAIL_VERIFICATION_INVALID');

    const crossPersonal = await request(app.getHttpServer())
      .post('/users/email-verification/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ otp: corporateOtp })
      .expect(400);
    expect(crossPersonal.body.code).toBe('EMAIL_VERIFICATION_INVALID');
  });

  it('isolates corporate verification between users', async () => {
    const userA = await createUser();
    const userB = await createUser();
    const email = `shared${Date.now()}@company.com`;

    await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ email })
      .expect(200);
    const otp = extractOtpFromSend();

    const stolen = await request(app.getHttpServer())
      .post('/corporate-identity/verify')
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .send({ email, otp })
      .expect(404);
    expect(stolen.body.code).toBe('EMAIL_VERIFICATION_NOT_FOUND');

    const statusB = await request(app.getHttpServer())
      .get('/corporate-identity/status')
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .expect(200);
    expect(statusB.body.status).toBe(CorporateIdentityStatus.NOT_VERIFIED);
  });

  it('is idempotent for already verified same email and supports email change atomically', async () => {
    const login = await createUser();
    const emailA = `a${Date.now()}@company.com`;
    const emailB = `b${Date.now()}@startup.co`;

    await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: emailA })
      .expect(200);
    const otpA = extractOtpFromSend();
    await request(app.getHttpServer())
      .post('/corporate-identity/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: emailA, otp: otpA })
      .expect(200);

    sendEmail.mockClear();
    const same = await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: emailA })
      .expect(200);
    expect(same.body.status).toBe(CorporateIdentityStatus.VERIFIED);
    expect(same.body.email).toBe(emailA);
    expect(sendEmail).not.toHaveBeenCalled();

    const record = await dataSource
      .getRepository(CorporateIdentityVerification)
      .findOneByOrFail({ userId: login.user.id });
    await dataSource.getRepository(EmailVerificationOtp).update(
      { userId: login.user.id, purpose: EmailOtpPurpose.CORPORATE_IDENTITY },
      { sentAt: new Date(Date.now() - 61_000) },
    );

    await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: emailB })
      .expect(200);

    const pending = await dataSource
      .getRepository(CorporateIdentityVerification)
      .findOneByOrFail({ userId: login.user.id });
    expect(pending.corporateEmail).toBe(emailA);
    expect(pending.pendingCorporateEmail).toBe(emailB);
    expect(pending.verifiedAt).toEqual(record.verifiedAt);

    const wrongB = await request(app.getHttpServer())
      .post('/corporate-identity/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: emailB, otp: '0000' })
      .expect(400);
    expect(wrongB.body.code).toBe('EMAIL_VERIFICATION_INVALID');

    const afterFail = await dataSource
      .getRepository(CorporateIdentityVerification)
      .findOneByOrFail({ userId: login.user.id });
    expect(afterFail.corporateEmail).toBe(emailA);

    const otpB = extractOtpFromSend();
    await request(app.getHttpServer())
      .post('/corporate-identity/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: emailB, otp: otpB })
      .expect(200);

    const afterSuccess = await dataSource
      .getRepository(CorporateIdentityVerification)
      .findOneByOrFail({ userId: login.user.id });
    expect(afterSuccess.corporateEmail).toBe(emailB);
    expect(afterSuccess.pendingCorporateEmail).toBeNull();
    expect(afterSuccess.status).toBe(CorporateIdentityStatus.VERIFIED);
  });

  it('keeps only one active pending corporate OTP per user', async () => {
    const login = await createUser();
    const emailA = `a${Date.now()}@company.com`;
    const emailB = `b${Date.now()}@startup.co`;

    await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: emailA })
      .expect(200);
    const otpA = extractOtpFromSend();

    await dataSource.getRepository(EmailVerificationOtp).update(
      { userId: login.user.id, purpose: EmailOtpPurpose.CORPORATE_IDENTITY },
      { sentAt: new Date(Date.now() - 61_000) },
    );

    sendEmail.mockClear();
    await request(app.getHttpServer())
      .post('/corporate-identity/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: emailB })
      .expect(200);

    const active = await dataSource.getRepository(EmailVerificationOtp).find({
      where: {
        userId: login.user.id,
        purpose: EmailOtpPurpose.CORPORATE_IDENTITY,
        invalidatedAt: IsNull(),
        verifiedAt: IsNull(),
      },
    });
    expect(active).toHaveLength(1);
    expect(active[0].email).toBe(emailB);

    const stale = await request(app.getHttpServer())
      .post('/corporate-identity/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: emailA, otp: otpA })
      .expect(404);
    expect(stale.body.code).toBe('EMAIL_VERIFICATION_NOT_FOUND');
  });

  it('does not create duplicate corporate identity records under concurrent creates', async () => {
    const login = await createUser();
    const email = `concurrent${Date.now()}@company.com`;

    await Promise.all([
      request(app.getHttpServer())
        .post('/corporate-identity/send')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ email }),
      request(app.getHttpServer())
        .post('/corporate-identity/send')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ email }),
    ]);

    const records = await dataSource
      .getRepository(CorporateIdentityVerification)
      .find({ where: { userId: login.user.id } });
    expect(records).toHaveLength(1);
  });
});
