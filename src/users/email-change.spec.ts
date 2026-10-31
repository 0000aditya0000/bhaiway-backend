import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { SmtpMailService } from '../email/smtp-mail.service';
import { EmailVerificationModule } from '../email-verification/email-verification.module';
import { EmailVerificationOtp } from '../email-verification/entities/email-verification-otp.entity';
import { EmailOtpPurpose } from '../email-verification/enums/email-otp-purpose.enum';
import { RatingsModule } from '../ratings/ratings.module';
import { User } from './entities/user.entity';
import { UsersModule } from './users.module';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';
import { WalletModule } from '../wallet/wallet.module';

interface SmtpCallPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
}

interface ApiResponsePayload {
  success?: boolean;
  message?: string;
  code?: string;
  user?: {
    email?: string;
    emailVerified?: boolean;
  };
}

describe('Change Email Address with OTP verification (integration)', () => {
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

  function api() {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return request(app.getHttpServer());
  }

  async function createUserWithEmail(
    email = `user${Date.now()}_${Math.random().toString(36).substring(7)}@example.com`,
  ) {
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

    await api()
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada', email })
      .expect(201);

    return { login, email: email.trim().toLowerCase() };
  }

  function extractOtpFromSend(callIndex = 0): string {
    const calls = sendEmail.mock.calls as Array<[SmtpCallPayload]>;
    const html = String(calls[callIndex][0].html);
    const match = html.match(/\b(\d{4})\b/);
    expect(match).not.toBeNull();
    return match![1];
  }

  function getCallPayload(callIndex = 0): SmtpCallPayload {
    const calls = sendEmail.mock.calls as Array<[SmtpCallPayload]>;
    return calls[callIndex][0];
  }

  it('rejects unauthenticated email change requests', async () => {
    await api()
      .post('/users/me/email/change/request')
      .send({ newEmail: 'new@example.com' })
      .expect(401);

    await api()
      .post('/users/me/email/change/verify')
      .send({ newEmail: 'new@example.com', otp: '1234' })
      .expect(401);
  });

  it('successful flow: sends OTP to new email, leaves current email unchanged, verifies and updates email', async () => {
    const { login, email: originalEmail } = await createUserWithEmail();
    const newEmail = `updated${Date.now()}@example.com`;

    // 1. Request email change
    const requestRes = await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail })
      .expect(200);

    const requestBody = requestRes.body as ApiResponsePayload;
    expect(requestBody).toEqual({
      success: true,
      message: 'Verification OTP sent to your new email address.',
    });
    expect(JSON.stringify(requestRes.body)).not.toMatch(/\b\d{4}\b/);

    // Verify email was sent to new email address
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sent = getCallPayload(0);
    expect(sent.to).toBe(newEmail);
    expect(sent.subject).toBe('Verify your new BhaiWay email address');
    const otp = extractOtpFromSend(0);

    // Current email MUST remain unchanged before verification
    const userBeforeVerify = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: login.user.id });
    expect(userBeforeVerify.email).toBe(originalEmail);

    // OTP record exists with purpose CHANGE_EMAIL
    const otpRecord = await dataSource
      .getRepository(EmailVerificationOtp)
      .findOneByOrFail({
        userId: login.user.id,
        purpose: EmailOtpPurpose.CHANGE_EMAIL,
        verifiedAt: IsNull(),
      });
    expect(otpRecord.email).toBe(newEmail);
    expect(otpRecord.otpHash).not.toContain(otp);

    // 2. Verify OTP and complete email change
    const verifyRes = await api()
      .post('/users/me/email/change/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail, otp })
      .expect(200);

    const verifyBody = verifyRes.body as ApiResponsePayload;
    expect(verifyBody).toEqual({
      success: true,
      message: 'Email address updated successfully.',
      user: {
        email: newEmail,
        emailVerified: true,
      },
    });

    // In database: user's email is updated and emailVerified is true
    const userAfterVerify = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: login.user.id });
    expect(userAfterVerify.email).toBe(newEmail);
    expect(userAfterVerify.emailVerified).toBe(true);

    // In database: OTP is consumed
    const consumedRecord = await dataSource
      .getRepository(EmailVerificationOtp)
      .findOneByOrFail({ id: otpRecord.id });
    expect(consumedRecord.verifiedAt).not.toBeNull();
    expect(consumedRecord.invalidatedAt).not.toBeNull();
  });

  it('rejects invalid email format on request and verify', async () => {
    const { login } = await createUserWithEmail();

    await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: 'not-an-email' })
      .expect(400);

    await api()
      .post('/users/me/email/change/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: 'not-an-email', otp: '1234' })
      .expect(400);
  });

  it('rejects when new email is the same as current email', async () => {
    const { login, email } = await createUserWithEmail();

    const res = await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: email })
      .expect(400);

    const body = res.body as ApiResponsePayload;
    expect(body.code).toBe('EMAIL_SAME_AS_CURRENT');

    // Case-insensitive check
    const upperRes = await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: email.toUpperCase() })
      .expect(400);

    const upperBody = upperRes.body as ApiResponsePayload;
    expect(upperBody.code).toBe('EMAIL_SAME_AS_CURRENT');
  });

  it('rejects when new email is already registered to another account', async () => {
    const { email: otherEmail } = await createUserWithEmail();
    const { login: currentUserLogin } = await createUserWithEmail();

    const res = await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${currentUserLogin.accessToken}`)
      .send({ newEmail: otherEmail })
      .expect(409);

    const body = res.body as ApiResponsePayload;
    expect(body.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('rejects wrong OTP with 400 and increments attempts', async () => {
    const { login, email: originalEmail } = await createUserWithEmail();
    const newEmail = `wrongotp${Date.now()}@example.com`;

    await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail })
      .expect(200);

    const res = await api()
      .post('/users/me/email/change/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail, otp: '0000' })
      .expect(400);

    const body = res.body as ApiResponsePayload;
    expect(body.code).toBe('EMAIL_VERIFICATION_INVALID');

    // Email remains unchanged
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: login.user.id });
    expect(user.email).toBe(originalEmail);

    // Attempt count is persisted
    const otpRecord = await dataSource
      .getRepository(EmailVerificationOtp)
      .findOneByOrFail({
        userId: login.user.id,
        purpose: EmailOtpPurpose.CHANGE_EMAIL,
      });
    expect(otpRecord.attempts).toBe(1);
    expect(otpRecord.verifiedAt).toBeNull();
  });

  it('rejects expired OTP with 400', async () => {
    const { login, email: originalEmail } = await createUserWithEmail();
    const newEmail = `expired${Date.now()}@example.com`;

    await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail })
      .expect(200);

    const otp = extractOtpFromSend(0);

    // Expire the OTP record in DB
    await dataSource
      .getRepository(EmailVerificationOtp)
      .update(
        { userId: login.user.id, purpose: EmailOtpPurpose.CHANGE_EMAIL },
        { expiresAt: new Date(Date.now() - 1000) },
      );

    const res = await api()
      .post('/users/me/email/change/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail, otp })
      .expect(400);

    const body = res.body as ApiResponsePayload;
    expect(body.code).toBe('EMAIL_VERIFICATION_EXPIRED');

    // Email remains unchanged
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: login.user.id });
    expect(user.email).toBe(originalEmail);
  });

  it('rejects reused OTP with 404', async () => {
    const { login } = await createUserWithEmail();
    const newEmail = `reused${Date.now()}@example.com`;

    await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail })
      .expect(200);

    const otp = extractOtpFromSend(0);

    // First verification succeeds
    await api()
      .post('/users/me/email/change/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail, otp })
      .expect(200);

    // Reusing the same OTP returns 404 NO_PENDING_EMAIL_CHANGE
    const reuseRes = await api()
      .post('/users/me/email/change/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail, otp })
      .expect(404);

    const body = reuseRes.body as ApiResponsePayload;
    expect(body.code).toBe('NO_PENDING_EMAIL_CHANGE');
  });

  it('locks out verification after 5 incorrect attempts with 429', async () => {
    const { login } = await createUserWithEmail();
    const newEmail = `lockout${Date.now()}@example.com`;

    await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail })
      .expect(200);

    const correctOtp = extractOtpFromSend(0);

    // Submit 4 incorrect attempts (each returns 400)
    for (let i = 0; i < 4; i++) {
      const res = await api()
        .post('/users/me/email/change/verify')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ newEmail, otp: '0000' })
        .expect(400);
      const body = res.body as ApiResponsePayload;
      expect(body.code).toBe('EMAIL_VERIFICATION_INVALID');
    }

    // 5th attempt returns 429
    const fifth = await api()
      .post('/users/me/email/change/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail, otp: '0000' })
      .expect(429);
    const fifthBody = fifth.body as ApiResponsePayload;
    expect(fifthBody.code).toBe('EMAIL_VERIFICATION_ATTEMPTS_EXCEEDED');

    // Subsequent attempt with correct OTP is blocked
    const blocked = await api()
      .post('/users/me/email/change/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail, otp: correctOtp })
      .expect(429);
    const blockedBody = blocked.body as ApiResponsePayload;
    expect(blockedBody.code).toBe('EMAIL_VERIFICATION_ATTEMPTS_EXCEEDED');
  });

  it('returns 404 NO_PENDING_EMAIL_CHANGE when no active change request exists', async () => {
    const { login } = await createUserWithEmail();

    const res = await api()
      .post('/users/me/email/change/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: 'unrequested@example.com', otp: '1234' })
      .expect(404);

    const body = res.body as ApiResponsePayload;
    expect(body.code).toBe('NO_PENDING_EMAIL_CHANGE');
  });

  it('returns 400 PENDING_EMAIL_MISMATCH when submitted email does not match pending email', async () => {
    const { login } = await createUserWithEmail();
    const pendingEmail = `pending${Date.now()}@example.com`;
    const differentEmail = `different${Date.now()}@example.com`;

    await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: pendingEmail })
      .expect(200);

    const otp = extractOtpFromSend(0);

    const res = await api()
      .post('/users/me/email/change/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: differentEmail, otp })
      .expect(400);

    const body = res.body as ApiResponsePayload;
    expect(body.code).toBe('PENDING_EMAIL_MISMATCH');
  });

  it('supersedes previous pending email change request on new request', async () => {
    const { login, email: originalEmail } = await createUserWithEmail();
    const firstTarget = `first${Date.now()}@example.com`;
    const secondTarget = `second${Date.now()}@example.com`;

    // First request
    await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: firstTarget })
      .expect(200);

    const firstOtp = extractOtpFromSend(0);

    // Age first OTP beyond cooldown so second request is allowed
    await dataSource
      .getRepository(EmailVerificationOtp)
      .update(
        { userId: login.user.id, purpose: EmailOtpPurpose.CHANGE_EMAIL },
        { sentAt: new Date(Date.now() - 61_000) },
      );

    // Second request with different email
    await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: secondTarget })
      .expect(200);

    const secondOtp = extractOtpFromSend(1);

    // Verifying first target fails because it has been superseded
    const firstVerifyRes = await api()
      .post('/users/me/email/change/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: firstTarget, otp: firstOtp })
      .expect(400);
    const firstBody = firstVerifyRes.body as ApiResponsePayload;
    expect(firstBody.code).toBe('PENDING_EMAIL_MISMATCH');

    // Verifying second target succeeds
    await api()
      .post('/users/me/email/change/verify')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: secondTarget, otp: secondOtp })
      .expect(200);

    const updatedUser = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: login.user.id });
    expect(updatedUser.email).toBe(secondTarget);
    expect(updatedUser.email).not.toBe(originalEmail);
  });

  it('enforces 60-second cooldown on resending OTP even across different email addresses', async () => {
    const { login } = await createUserWithEmail();
    const targetA = `cooldown_a_${Date.now()}@example.com`;
    const targetB = `cooldown_b_${Date.now()}@example.com`;

    await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: targetA })
      .expect(200);

    // Immediate request with targetB is blocked by cooldown
    const res = await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: targetB })
      .expect(429);

    const body = res.body as ApiResponsePayload;
    expect(body.code).toBe('EMAIL_VERIFICATION_COOLDOWN');
  });

  it('enforces 5 sends per rolling hour limit', async () => {
    const { login } = await createUserWithEmail();

    for (let i = 0; i < 5; i++) {
      const email = `hourly_${i}_${Date.now()}@example.com`;
      await api()
        .post('/users/me/email/change/request')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ newEmail: email })
        .expect(200);

      // Fast-forward past cooldown
      await dataSource
        .getRepository(EmailVerificationOtp)
        .update(
          { userId: login.user.id, purpose: EmailOtpPurpose.CHANGE_EMAIL },
          { sentAt: new Date(Date.now() - 61_000) },
        );
    }

    // 6th attempt within the hour is rate-limited
    const rateLimitedRes = await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: `hourly_6_${Date.now()}@example.com` })
      .expect(429);

    const body = rateLimitedRes.body as ApiResponsePayload;
    expect(body.code).toBe('EMAIL_VERIFICATION_RATE_LIMITED');
  });

  it('fails safely if another user claims the pending email between request and verification', async () => {
    const { login: userA, email: userAOriginalEmail } =
      await createUserWithEmail();
    const targetEmail = `raced_${Date.now()}@example.com`;

    // User A requests change to targetEmail
    await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ newEmail: targetEmail })
      .expect(200);

    const otp = extractOtpFromSend(0);

    // Another user (User B) registers targetEmail in the meantime
    await createUserWithEmail(targetEmail);

    // User A attempts to verify OTP for targetEmail
    const verifyRes = await api()
      .post('/users/me/email/change/verify')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ newEmail: targetEmail, otp })
      .expect(409);

    const body = verifyRes.body as ApiResponsePayload;
    expect(body.code).toBe('EMAIL_ALREADY_REGISTERED');

    // User A's email remains unchanged
    const userAAfter = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: userA.user.id });
    expect(userAAfter.email).toBe(userAOriginalEmail);
  });

  it('generic profile update cannot bypass OTP verification', async () => {
    const { login, email } = await createUserWithEmail();

    // Trying to pass email via PATCH /users/profile is rejected by ValidationPipe
    await api()
      .patch('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: 'hacker@example.com' })
      .expect(400);

    await api()
      .patch('/users/me/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ email: 'hacker@example.com' })
      .expect(400);

    // Email remains unchanged
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: login.user.id });
    expect(user.email).toBe(email);
  });

  it('user cannot verify another user OTP', async () => {
    const { login: userA } = await createUserWithEmail();
    const { login: userB } = await createUserWithEmail();
    const targetEmail = `isolated_${Date.now()}@example.com`;

    // User A requests email change
    await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ newEmail: targetEmail })
      .expect(200);

    const otp = extractOtpFromSend(0);

    // User B tries to verify using User A's OTP
    const res = await api()
      .post('/users/me/email/change/verify')
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .send({ newEmail: targetEmail, otp })
      .expect(404);

    const body = res.body as ApiResponsePayload;
    expect(body.code).toBe('NO_PENDING_EMAIL_CHANGE');
  });

  it('invalidates OTP and throws 502 if SMTP delivery fails', async () => {
    const { login } = await createUserWithEmail();
    sendEmail.mockRejectedValueOnce(new Error('SMTP down'));

    await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: `smtpfail_${Date.now()}@example.com` })
      .expect(502);

    // OTP in database was invalidated
    const record = await dataSource
      .getRepository(EmailVerificationOtp)
      .findOneByOrFail({
        userId: login.user.id,
        purpose: EmailOtpPurpose.CHANGE_EMAIL,
      });
    expect(record.invalidatedAt).not.toBeNull();
  });

  it('handles concurrent requests to claim the same email address: only one succeeds', async () => {
    const { login: userA } = await createUserWithEmail();
    const { login: userB } = await createUserWithEmail();
    const targetEmail = `concurrent_${Date.now()}@example.com`;

    // User A requests change
    await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ newEmail: targetEmail })
      .expect(200);
    const otpA = extractOtpFromSend(0);

    // User B requests change to same email (User B has separate cooldown)
    await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .send({ newEmail: targetEmail })
      .expect(200);
    const otpB = extractOtpFromSend(1);

    // Fire both verifications concurrently
    const [resA, resB] = await Promise.all([
      api()
        .post('/users/me/email/change/verify')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ newEmail: targetEmail, otp: otpA }),
      api()
        .post('/users/me/email/change/verify')
        .set('Authorization', `Bearer ${userB.accessToken}`)
        .send({ newEmail: targetEmail, otp: otpB }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    // Database check: exactly one user has the email
    const usersWithEmail = await dataSource.getRepository(User).count({
      where: { email: targetEmail },
    });
    expect(usersWithEmail).toBe(1);
  });

  it('database failure during update rolls back transaction and leaves email unchanged', async () => {
    const { login, email: originalEmail } = await createUserWithEmail();
    const targetEmail = `dbfailure_${Date.now()}@example.com`;

    await api()
      .post('/users/me/email/change/request')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ newEmail: targetEmail })
      .expect(200);
    const otp = extractOtpFromSend(0);

    // Spy on EntityManager.prototype.save to throw during user update
    const saveSpy = jest
      .spyOn(EntityManager.prototype, 'save')
      .mockRejectedValueOnce(new Error('Simulated DB error during user save'));

    try {
      await api()
        .post('/users/me/email/change/verify')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ newEmail: targetEmail, otp })
        .expect(500);

      // Current email remains unchanged
      const userAfter = await dataSource
        .getRepository(User)
        .findOneByOrFail({ id: login.user.id });
      expect(userAfter.email).toBe(originalEmail);
    } finally {
      saveSpy.mockRestore();
    }
  });
});
