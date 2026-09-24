import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
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
import { EmailVerificationModule } from './email-verification.module';
import { EmailVerificationOtp } from './entities/email-verification-otp.entity';
import {
  EMAIL_OTP_MAX_ATTEMPTS,
  EMAIL_OTP_MAX_SENDS_PER_HOUR,
} from './email-verification.constants';

describe('Email verification (integration)', () => {
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
        await cleanupTestWallet(dataSource, ctx);
      }
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  async function createUserWithEmail(email = `user${Date.now()}@example.com`) {
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

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada', email })
      .expect(201);

    return { login, email: email.trim().toLowerCase() };
  }

  function extractOtpFromSend(): string {
    const html = String(sendEmail.mock.calls[0][0].html);
    const match = html.match(/\b(\d{4})\b/);
    expect(match).not.toBeNull();
    return match![1];
  }

  it('unauthenticated requests are rejected', async () => {
    await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .send({ email: 'user@example.com' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/users/email-verification/verify')
      .send({ otp: '1234' })
      .expect(401);
    await request(app.getHttpServer())
      .get('/users/email-verification/status')
      .expect(401);
  });

  it('sends a hashed OTP via SMTP from alerts@kodenzolabs.in', async () => {
    const { login, email } = await createUserWithEmail();

    const res = await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(200);

    expect(res.body).toEqual({
      success: true,
      message: 'Verification code sent to your email.',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/\b\d{4}\b/);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        to: email,
        subject: 'Verify your BhaiWay email address',
      }),
    );
    expect(sendEmail.mock.calls[0][0].html).toMatch(/\b\d{4}\b/);
    expect(sendEmail.mock.calls[0][0].text).toMatch(/\b\d{4}\b/);

    const stored = await dataSource
      .getRepository(EmailVerificationOtp)
      .findOneByOrFail({ userId: login.user.id });
    const otp = extractOtpFromSend();
    expect(stored.otpHash).not.toContain(otp);
    expect(stored.attempts).toBe(0);
    expect(stored.maxAttempts).toBe(EMAIL_OTP_MAX_ATTEMPTS);
  });

  it('returns EMAIL_MISMATCH when the email is not on the account', async () => {
    const { login } = await createUserWithEmail();
    const res = await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: 'other@example.com' })
      .expect(403);
    expect(res.body.code).toBe('EMAIL_MISMATCH');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('returns EMAIL_ALREADY_VERIFIED when the email is already verified', async () => {
    const { login, email } = await createUserWithEmail();
    await dataSource.getRepository(User).update(
      { id: login.user.id },
      { emailVerified: true },
    );

    const res = await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(409);
    expect(res.body.code).toBe('EMAIL_ALREADY_VERIFIED');
  });

  it('enforces a 60-second resend cooldown', async () => {
    const { login, email } = await createUserWithEmail();
    await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(429);
    expect(res.body.code).toBe('EMAIL_VERIFICATION_COOLDOWN');
  });

  it('enforces 5 sends per rolling hour', async () => {
    const { login, email } = await createUserWithEmail();
    const repo = dataSource.getRepository(EmailVerificationOtp);
    const now = Date.now();
    for (let i = 0; i < EMAIL_OTP_MAX_SENDS_PER_HOUR; i += 1) {
      await repo.save(
        repo.create({
          userId: login.user.id,
          email,
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

    const res = await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(429);
    expect(res.body.code).toBe('EMAIL_VERIFICATION_RATE_LIMITED');
  });

  it('invalidates the previous OTP when a new one is created', async () => {
    const { login, email } = await createUserWithEmail();
    await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(200);
    const firstOtp = extractOtpFromSend();
    const first = await dataSource.getRepository(EmailVerificationOtp).findOneOrFail({
      where: { userId: login.user.id, invalidatedAt: IsNull() },
    });

    await dataSource.getRepository(EmailVerificationOtp).update(
      { id: first.id },
      { sentAt: new Date(Date.now() - 61_000) },
    );

    sendEmail.mockClear();
    await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(200);

    const firstReloaded = await dataSource
      .getRepository(EmailVerificationOtp)
      .findOneByOrFail({ id: first.id });
    expect(firstReloaded.invalidatedAt).not.toBeNull();

    const verifyOld = await request(app.getHttpServer())
      .post('/users/email-verification/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ otp: firstOtp })
      .expect(400);
    expect(verifyOld.body.code).toBe('EMAIL_VERIFICATION_INVALID');
  });

  it('verifies the correct OTP and is single-use', async () => {
    const { login, email } = await createUserWithEmail();
    await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(200);
    const otp = extractOtpFromSend();

    const verified = await request(app.getHttpServer())
      .post('/users/email-verification/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ otp })
      .expect(200);
    expect(verified.body).toEqual({
      success: true,
      message: 'Email verified successfully.',
    });

    const user = await dataSource.getRepository(User).findOneByOrFail({
      id: login.user.id,
    });
    expect(user.emailVerified).toBe(true);

    const reused = await request(app.getHttpServer())
      .post('/users/email-verification/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ otp })
      .expect(409);
    expect(reused.body.code).toBe('EMAIL_ALREADY_VERIFIED');
  });

  it('rejects a wrong OTP', async () => {
    const { login, email } = await createUserWithEmail();
    await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/users/email-verification/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ otp: '0000' })
      .expect(400);
    expect(res.body.code).toBe('EMAIL_VERIFICATION_INVALID');
  });

  it('expires an OTP after 10 minutes', async () => {
    const { login, email } = await createUserWithEmail();
    await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(200);
    const otp = extractOtpFromSend();
    const record = await dataSource.getRepository(EmailVerificationOtp).findOneOrFail({
      where: { userId: login.user.id, invalidatedAt: IsNull() },
    });
    await dataSource.getRepository(EmailVerificationOtp).update(
      { id: record.id },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    const res = await request(app.getHttpServer())
      .post('/users/email-verification/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ otp })
      .expect(400);
    expect(res.body.code).toBe('EMAIL_VERIFICATION_EXPIRED');
  });

  it('blocks verification after 5 incorrect attempts', async () => {
    const { login, email } = await createUserWithEmail();
    await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(200);

    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer())
        .post('/users/email-verification/verify')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ otp: '0000' });
    }

    const res = await request(app.getHttpServer())
      .post('/users/email-verification/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ otp: '0000' })
      .expect(429);
    expect(res.body.code).toBe('EMAIL_VERIFICATION_ATTEMPTS_EXCEEDED');
  });

  it('returns EMAIL_VERIFICATION_NOT_FOUND when no OTP exists', async () => {
    const { login } = await createUserWithEmail();
    const res = await request(app.getHttpServer())
      .post('/users/email-verification/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ otp: '1234' })
      .expect(404);
    expect(res.body.code).toBe('EMAIL_VERIFICATION_NOT_FOUND');
  });

  it('invalidates the OTP when SMTP send fails', async () => {
    const { login, email } = await createUserWithEmail();
    sendEmail.mockRejectedValueOnce(new Error('smtp down'));

    const res = await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(502);
    expect(res.body.code).toBe('EMAIL_SEND_FAILED');

    const stored = await dataSource
      .getRepository(EmailVerificationOtp)
      .find({ where: { userId: login.user.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0].invalidatedAt).not.toBeNull();
  });

  it('returns status without OTP details', async () => {
    const { login, email } = await createUserWithEmail();
    const res = await request(app.getHttpServer())
      .get('/users/email-verification/status')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);
    expect(res.body).toEqual({ email, verified: false });
    expect(res.body).not.toHaveProperty('otp');
    expect(res.body).not.toHaveProperty('otpHash');
  });

  it('never logs the OTP or SMTP password', async () => {
    const secret = 'smtp-should-never-appear';
    process.env.SMTP_PASSWORD = secret;
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const { login, email } = await createUserWithEmail();
    await request(app.getHttpServer())
      .post('/users/email-verification/send')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email })
      .expect(200);
    const otp = extractOtpFromSend();

    const logs = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map(String)
      .join('\n');
    expect(logs).not.toContain(otp);
    expect(logs).not.toContain(secret);

    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
