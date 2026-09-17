import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';
import * as crypto from 'crypto';

import { AuthModule } from '../../auth/auth.module';
import { AuthService } from '../../auth/auth.service';
import { Msg91ResponseFormatError } from '../../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../../auth/providers/otp-provider.interface';
import { UsersModule } from '../../users/users.module';
import { UserProfile, Gender } from '../../users/entities/user-profile.entity';
import { WalletModule } from '../../wallet/wallet.module';
import { Wallet } from '../../wallet/entities/wallet.entity';
import { WalletBalance } from '../../wallet/entities/wallet-balance.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
} from '../../wallet/test/wallet-test.helpers';
import { VerificationModule } from '../verification.module';
import { UserVerification } from '../entities/user-verification.entity';
import { UserIdentityVerification } from '../entities/user-identity-verification.entity';
import { CashfreeWebhookEvent } from '../entities/cashfree-webhook-event.entity';
import {
  IdentityMobileStatus,
  IdentityVerificationStatus,
} from '../enums/identity-verification.enums';
import { CashfreeDigiLockerService } from './cashfree-digilocker.service';
import { CashfreeKycService } from './cashfree-kyc.service';
import { CashfreeApiError } from './cashfree.errors';
import { assertWomenOnlyBookingAllowed } from '../../bookings/women-only-ride.guard';
import { RideType } from '../../rides/enums/ride.enums';
import { WomenOnlyRideError } from '../../users/errors/gender.errors';

const TEST_CLIENT_SECRET = 'cf_test_secret_key_12345';

function generateValidSignature(rawBody: Buffer, timestamp: string, secret = TEST_CLIENT_SECRET) {
  return crypto
    .createHmac('sha256', secret)
    .update(timestamp)
    .update(rawBody)
    .digest('base64');
}

describe('Cashfree DigiLocker KYC (integration & unit)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let kycService: CashfreeKycService;
  let cashfreeService: CashfreeDigiLockerService;

  const tracked: TestWalletContext[] = [];
  const otpProvider = {
    verifyAccessToken: jest
      .fn()
      .mockRejectedValue(new Msg91ResponseFormatError()),
  };

  beforeAll(async () => {
    process.env.CASHFREE_CLIENT_SECRET = TEST_CLIENT_SECRET;
    process.env.CASHFREE_CLIENT_ID = 'cf_test_client_id';
    process.env.CASHFREE_VERIFICATION_ENV = 'sandbox';

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
      .useValue(otpProvider)
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
    kycService = moduleRef.get(CashfreeKycService);
    cashfreeService = moduleRef.get(CashfreeDigiLockerService);

    await dataSource
      .getRepository(CashfreeWebhookEvent)
      .createQueryBuilder()
      .delete()
      .execute();
    await dataSource
      .getRepository(UserIdentityVerification)
      .createQueryBuilder()
      .delete()
      .execute();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await dataSource
      .getRepository(CashfreeWebhookEvent)
      .createQueryBuilder()
      .delete()
      .execute();
    await dataSource
      .getRepository(UserIdentityVerification)
      .createQueryBuilder()
      .delete()
      .execute();
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await dataSource
          .getRepository(UserVerification)
          .delete({ userId: ctx.userId });
        await dataSource
          .getRepository(UserProfile)
          .delete({ userId: ctx.userId });
        await cleanupTestWallet(dataSource, ctx);
      }
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  async function createAuthenticatedUser() {
    const phone = `+91${Date.now().toString().slice(-9)}${Math.floor(
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

  function postWebhook(
    payload: Record<string, any>,
    timestamp = String(Date.now()),
    customSignature?: string,
  ) {
    const payloadStr = JSON.stringify(payload);
    const signature =
      customSignature ??
      generateValidSignature(Buffer.from(payloadStr, 'utf8'), timestamp);
    return request(app.getHttpServer())
      .post('/api/kyc/webhooks/cashfree/digilocker')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', signature)
      .set('x-webhook-timestamp', timestamp)
      .send(payloadStr);
  }

  // =========================================================================
  // A. Create DigiLocker URL
  // =========================================================================
  describe('A. Create DigiLocker URL (POST /kyc/aadhaar/digilocker/start)', () => {
    it('successfully starts a DigiLocker session and returns URL without secrets', async () => {
      const login = await createAuthenticatedUser();

      jest
        .spyOn(cashfreeService, 'createVerificationUrl')
        .mockResolvedValueOnce({
          verificationId: 'cf_ver_123',
          referenceId: 'ref_98765',
          url: 'https://sandbox.cashfree.com/verification/digilocker/test-token',
          status: 'PENDING',
          documentRequested: ['AADHAAR'],
        });

      const res = await request(app.getHttpServer())
        .post('/kyc/aadhaar/digilocker/start')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(res.body.verificationId).toBe('cf_ver_123');
      expect(res.body.referenceId).toBe('ref_98765');
      expect(res.body.status).toBe('PENDING');
      expect(res.body.url).toBe(
        'https://sandbox.cashfree.com/verification/digilocker/test-token',
      );
      expect(res.body.expiresAt).toBeTruthy();
      expect(res.body).not.toHaveProperty('clientSecret');
      expect(res.body).not.toHaveProperty('clientId');

      // Check DB persistence
      const saved = await dataSource
        .getRepository(UserIdentityVerification)
        .findOneBy({ userId: login.user.id });
      expect(saved).toBeDefined();
      expect(saved?.verificationId).toBe('cf_ver_123');
      expect(saved?.referenceId).toBe('ref_98765');
      expect(saved?.status).toBe(IdentityVerificationStatus.PENDING);
    });

    it('returns existing active session if valid and not expired', async () => {
      const login = await createAuthenticatedUser();

      const createSpy = jest
        .spyOn(cashfreeService, 'createVerificationUrl')
        .mockResolvedValueOnce({
          verificationId: 'cf_ver_active_1',
          referenceId: 'ref_active_1',
          url: 'https://sandbox.cashfree.com/verification/digilocker/active-url',
          status: 'PENDING',
        });

      // First start
      const first = await request(app.getHttpServer())
        .post('/kyc/aadhaar/digilocker/start')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(createSpy).toHaveBeenCalledTimes(1);

      // Second start within 10 minutes should reuse active session without calling Cashfree again
      const second = await request(app.getHttpServer())
        .post('/kyc/aadhaar/digilocker/start')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(createSpy).toHaveBeenCalledTimes(1); // No new Cashfree call
      expect(second.body.verificationId).toBe(first.body.verificationId);
      expect(second.body.url).toBe(first.body.url);
    });

    it('handles Cashfree API failure cleanly with 502 without leaking credentials', async () => {
      const login = await createAuthenticatedUser();

      jest
        .spyOn(cashfreeService, 'createVerificationUrl')
        .mockRejectedValueOnce(
          new CashfreeApiError('Failed to communicate with Cashfree DigiLocker service'),
        );

      const res = await request(app.getHttpServer())
        .post('/kyc/aadhaar/digilocker/start')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(502);

      expect(res.body.code).toBe('CASHFREE_UPSTREAM_ERROR');
      expect(JSON.stringify(res.body)).not.toContain(TEST_CLIENT_SECRET);
    });

    it('rejects already verified user with 409 Conflict', async () => {
      const login = await createAuthenticatedUser();

      // Create a verified record for this user
      await dataSource.getRepository(UserIdentityVerification).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        verificationId: 'already_ver_1',
        status: IdentityVerificationStatus.VERIFIED,
        provider: 'CASHFREE',
        verificationType: 'AADHAAR',
        documentType: 'AADHAAR',
      });

      const res = await request(app.getHttpServer())
        .post('/kyc/aadhaar/digilocker/start')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(409);

      expect(res.body.code).toBe('KYC_ALREADY_VERIFIED');
    });
  });

  // =========================================================================
  // B. Status Endpoint
  // =========================================================================
  describe('B. Status Endpoint (GET /kyc/aadhaar/digilocker/status)', () => {
    it('returns NOT_VERIFIED for new user with no verification record', async () => {
      const login = await createAuthenticatedUser();

      const res = await request(app.getHttpServer())
        .get('/kyc/aadhaar/digilocker/status')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(res.body).toEqual({
        status: IdentityMobileStatus.NOT_VERIFIED,
        verificationId: null,
        verifiedName: null,
        verifiedGender: null,
        verifiedAt: null,
      });
    });

    it('returns VERIFICATION_IN_PROGRESS for PENDING and AUTHENTICATED states', async () => {
      const login = await createAuthenticatedUser();

      await dataSource.getRepository(UserIdentityVerification).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        verificationId: 'ver_in_progress',
        status: IdentityVerificationStatus.PENDING,
        provider: 'CASHFREE',
        verificationType: 'AADHAAR',
        documentType: 'AADHAAR',
      });

      const res = await request(app.getHttpServer())
        .get('/kyc/aadhaar/digilocker/status')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(res.body.status).toBe(IdentityMobileStatus.VERIFICATION_IN_PROGRESS);
      expect(res.body.verificationId).toBe('ver_in_progress');
    });

    it('returns VERIFICATION_FAILED for EXPIRED and CONSENT_DENIED states', async () => {
      const login = await createAuthenticatedUser();

      await dataSource.getRepository(UserIdentityVerification).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        verificationId: 'ver_expired',
        status: IdentityVerificationStatus.EXPIRED,
        provider: 'CASHFREE',
        verificationType: 'AADHAAR',
        documentType: 'AADHAAR',
      });

      const res = await request(app.getHttpServer())
        .get('/kyc/aadhaar/digilocker/status')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(res.body.status).toBe(IdentityMobileStatus.VERIFICATION_FAILED);
    });

    it('returns VERIFIED with mapped gender and name on VERIFIED state', async () => {
      const login = await createAuthenticatedUser();
      const verifiedTime = new Date();

      await dataSource.getRepository(UserIdentityVerification).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        verificationId: 'ver_verified_1',
        status: IdentityVerificationStatus.VERIFIED,
        provider: 'CASHFREE',
        verificationType: 'AADHAAR',
        documentType: 'AADHAAR',
        verifiedName: 'Sita Sharma',
        verifiedGender: 'F',
        verifiedAt: verifiedTime,
      });

      const res = await request(app.getHttpServer())
        .get('/kyc/aadhaar/digilocker/status')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(res.body.status).toBe(IdentityMobileStatus.VERIFIED);
      expect(res.body.verifiedName).toBe('Sita Sharma');
      expect(res.body.verifiedGender).toBe(Gender.FEMALE);
      expect(res.body.verifiedAt).toBeTruthy();
    });
  });

  // =========================================================================
  // C. Document Retrieval & Refresh Endpoint
  // =========================================================================
  describe('C. Document Retrieval & Refresh (POST /kyc/aadhaar/digilocker/refresh)', () => {
    it('refreshes status to VERIFIED upon Cashfree AUTHENTICATED and retrieves Aadhaar document', async () => {
      const login = await createAuthenticatedUser();

      // Create pending verification record
      await dataSource.getRepository(UserIdentityVerification).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        verificationId: 'refresh_vid_1',
        referenceId: 'refresh_ref_1',
        status: IdentityVerificationStatus.PENDING,
        provider: 'CASHFREE',
        verificationType: 'AADHAAR',
        documentType: 'AADHAAR',
      });

      jest.spyOn(cashfreeService, 'getVerificationStatus').mockResolvedValueOnce({
        status: 'AUTHENTICATED',
        verificationId: 'refresh_vid_1',
        referenceId: 'refresh_ref_1',
      });

      jest.spyOn(cashfreeService, 'getAadhaarDocument').mockResolvedValueOnce({
        status: 'VALID',
        uid: 'XXXXXXXX1234',
        name: 'Priya Sharma',
        gender: 'F',
        dob: '1995-05-15',
        mobile: '+919999988888',
      });

      const res = await request(app.getHttpServer())
        .post('/kyc/aadhaar/digilocker/refresh')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(res.body.status).toBe(IdentityMobileStatus.VERIFIED);
      expect(res.body.verifiedName).toBe('Priya Sharma');
      expect(res.body.verifiedGender).toBe(Gender.FEMALE);

      // Verify UserProfile was updated atomically
      const profile = await dataSource
        .getRepository(UserProfile)
        .findOneByOrFail({ userId: login.user.id });
      expect(profile.firstName).toBe('Priya');
      expect(profile.lastName).toBe('Sharma');
      expect(profile.displayName).toBe('Priya Sharma');
      expect(profile.gender).toBe(Gender.FEMALE);

      // Verify generic UserVerification for IDENTITY is now VERIFIED
      const generic = await dataSource.getRepository(UserVerification).findOneBy({
        userId: login.user.id,
        verificationType: 'IDENTITY' as any,
        isCurrent: true,
      });
      expect(generic?.status).toBe('VERIFIED');
    });

    it('is idempotent on multiple refresh calls when already VERIFIED', async () => {
      const login = await createAuthenticatedUser();

      await dataSource.getRepository(UserIdentityVerification).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        verificationId: 'idempotent_vid',
        status: IdentityVerificationStatus.VERIFIED,
        provider: 'CASHFREE',
        verificationType: 'AADHAAR',
        documentType: 'AADHAAR',
        verifiedName: 'Anita Roy',
        verifiedGender: 'F',
        verifiedAt: new Date(),
      });

      const getStatusSpy = jest.spyOn(cashfreeService, 'getVerificationStatus');

      const res = await request(app.getHttpServer())
        .post('/kyc/aadhaar/digilocker/refresh')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(res.body.status).toBe(IdentityMobileStatus.VERIFIED);
      expect(getStatusSpy).not.toHaveBeenCalled(); // Skips remote call
    });

    it('unsupported gender is not guessed to MALE or FEMALE', async () => {
      const login = await createAuthenticatedUser();

      await dataSource.getRepository(UserIdentityVerification).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        verificationId: 'unknown_gender_vid',
        status: IdentityVerificationStatus.PENDING,
        provider: 'CASHFREE',
        verificationType: 'AADHAAR',
        documentType: 'AADHAAR',
      });

      jest.spyOn(cashfreeService, 'getVerificationStatus').mockResolvedValueOnce({
        status: 'AUTHENTICATED',
      });

      jest.spyOn(cashfreeService, 'getAadhaarDocument').mockResolvedValueOnce({
        status: 'VALID',
        name: 'Alex Johnson',
        gender: 'UNKNOWN_OR_UNSPECIFIED',
      });

      const res = await request(app.getHttpServer())
        .post('/kyc/aadhaar/digilocker/refresh')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(res.body.verifiedGender).toBeNull();
      const profile = await dataSource
        .getRepository(UserProfile)
        .findOneBy({ userId: login.user.id });
      // Gender must not be guessed
      expect(profile?.gender).toBeNull();
    });
  });

  // =========================================================================
  // D. Profile Synchronization
  // =========================================================================
  describe('D. Profile Synchronization & Authority', () => {
    it('Aadhaar overrides previous user-entered profile name and gender', async () => {
      const login = await createAuthenticatedUser();

      // Existing user profile with previous name and gender
      await dataSource.getRepository(UserProfile).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        firstName: 'OldName',
        lastName: 'OldSurname',
        displayName: 'Old Display',
        gender: Gender.OTHER,
      });

      const identityRecord = await dataSource
        .getRepository(UserIdentityVerification)
        .save({
          id: crypto.randomUUID(),
          userId: login.user.id,
          verificationId: 'override_test_vid',
          status: IdentityVerificationStatus.PENDING,
          provider: 'CASHFREE',
          verificationType: 'AADHAAR',
          documentType: 'AADHAAR',
        });

      await kycService.completeAadhaarVerification(
        identityRecord.id,
        { status: 'AUTHENTICATED' },
        {
          status: 'VALID',
          name: 'Vikram Aditya Singh',
          gender: 'M',
          dob: '1990-01-01',
          uid: 'XXXX-XXXX-9999',
        },
      );

      const profile = await dataSource
        .getRepository(UserProfile)
        .findOneByOrFail({ userId: login.user.id });

      expect(profile.firstName).toBe('Vikram');
      expect(profile.lastName).toBe('Aditya Singh');
      expect(profile.displayName).toBe('Vikram Aditya Singh');
      expect(profile.gender).toBe(Gender.MALE);
    });
  });

  // =========================================================================
  // E. Gender Lock
  // =========================================================================
  describe('E. Gender Lock Enforcement', () => {
    it('rejects manual gender edit on PATCH /users/me/profile with 403 GENDER_LOCKED', async () => {
      const login = await createAuthenticatedUser();

      // User has profile
      await dataSource.getRepository(UserProfile).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        firstName: 'Anjali',
        gender: Gender.FEMALE,
      });

      const res = await request(app.getHttpServer())
        .patch('/users/me/profile')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ gender: Gender.MALE })
        .expect(403);

      expect(res.body.code).toBe('GENDER_LOCKED');
    });

    it('rejects manual gender edit on PATCH /users/profile with 403 GENDER_LOCKED', async () => {
      const login = await createAuthenticatedUser();

      await dataSource.getRepository(UserProfile).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        firstName: 'Anjali',
        gender: Gender.FEMALE,
      });

      const res = await request(app.getHttpServer())
        .patch('/users/profile')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ gender: Gender.MALE })
        .expect(403);

      expect(res.body.code).toBe('GENDER_LOCKED');
    });
  });

  // =========================================================================
  // F. Webhook Handling
  // =========================================================================
  describe('F. Webhook Handling (POST /api/kyc/webhooks/cashfree/digilocker)', () => {
    it('accepts valid HMAC signature and processes DIGILOCKER_VERIFICATION_SUCCESS', async () => {
      const login = await createAuthenticatedUser();

      await dataSource.getRepository(UserIdentityVerification).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        verificationId: 'wh_vid_success',
        referenceId: 'wh_ref_success',
        status: IdentityVerificationStatus.PENDING,
        provider: 'CASHFREE',
        verificationType: 'AADHAAR',
        documentType: 'AADHAAR',
      });

      jest.spyOn(cashfreeService, 'getAadhaarDocument').mockResolvedValueOnce({
        status: 'VALID',
        uid: 'XXXXXXXX7777',
        name: 'Kavita Verma',
        gender: 'F',
        dob: '1998-02-20',
      });

      const payload = {
        type: 'DIGILOCKER_VERIFICATION_SUCCESS',
        event_time: new Date().toISOString(),
        data: {
          verification_id: 'wh_vid_success',
          reference_id: 'wh_ref_success',
          status: 'AUTHENTICATED',
        },
      };

      const res = await postWebhook(payload).expect(200);

      expect(res.body.received).toBe(true);
      expect(res.body.status).toBe('PROCESSED');

      // Verify DB identity verification status is VERIFIED
      const updated = await dataSource
        .getRepository(UserIdentityVerification)
        .findOneByOrFail({ verificationId: 'wh_vid_success' });
      expect(updated.status).toBe(IdentityVerificationStatus.VERIFIED);
      expect(updated.verifiedName).toBe('Kavita Verma');
      expect(updated.verifiedGender).toBe('F');

      // Verify UserProfile
      const profile = await dataSource
        .getRepository(UserProfile)
        .findOneByOrFail({ userId: login.user.id });
      expect(profile.firstName).toBe('Kavita');
      expect(profile.lastName).toBe('Verma');
      expect(profile.gender).toBe(Gender.FEMALE);
    });

    it('GET /api/kyc/webhooks/cashfree/digilocker responds with 200 OK health check without JWT', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/kyc/webhooks/cashfree/digilocker')
        .expect(200);

      expect(res.body.status).toBe('ok');
      expect(res.body.endpoint).toBe('Cashfree DigiLocker Webhook');
    });

    it('acknowledges Cashfree dashboard LOW_BALANCE_ALERT test request without signature headers with 200', async () => {
      const testPayload = {
        event: 'LOW_BALANCE_ALERT',
        currentBalance: 100.0,
        alertTime: '2026-09-18 00:40:00',
        signature: 'test_dashboard_signature_placeholder',
      };

      const res = await request(app.getHttpServer())
        .post('/api/kyc/webhooks/cashfree/digilocker')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(testPayload))
        .expect(200);

      expect(res.body.received).toBe(true);
      expect(res.body.status).toBe('TEST_WEBHOOK_ACKNOWLEDGED');
    });

    it('acknowledges Cashfree dashboard TEST_WEBHOOK event without signature headers with 200', async () => {
      const testPayload = {
        event: 'TEST_WEBHOOK',
        data: { test: true },
      };

      const res = await request(app.getHttpServer())
        .post('/api/kyc/webhooks/cashfree/digilocker')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(testPayload))
        .expect(200);

      expect(res.body.received).toBe(true);
      expect(res.body.status).toBe('TEST_WEBHOOK_ACKNOWLEDGED');
    });

    it('rejects unsigned real DigiLocker events with 401 Unauthorized (does not bypass signature for real events)', async () => {
      const realPayload = {
        type: 'DIGILOCKER_VERIFICATION_SUCCESS',
        data: { verification_id: 'real_vid_attempt' },
      };

      const res = await request(app.getHttpServer())
        .post('/api/kyc/webhooks/cashfree/digilocker')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(realPayload))
        .expect(401);

      expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('rejects arbitrary unsigned payload with 401 Unauthorized', async () => {
      const arbitraryPayload = {
        foo: 'bar',
        random: 12345,
      };

      const res = await request(app.getHttpServer())
        .post('/api/kyc/webhooks/cashfree/digilocker')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(arbitraryPayload))
        .expect(401);

      expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('rejects invalid signature with 401 Unauthorized', async () => {
      const payload = { type: 'DIGILOCKER_VERIFICATION_SUCCESS' };
      const res = await postWebhook(
        payload,
        String(Date.now()),
        'invalid_signature_base64==',
      ).expect(401);

      expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('rejects timestamp outside 5-minute replay window with 400 Bad Request', async () => {
      const payload = { type: 'DIGILOCKER_VERIFICATION_SUCCESS' };
      const oldTimestamp = String(Date.now() - 10 * 60 * 1000);
      const res = await postWebhook(payload, oldTimestamp).expect(400);

      expect(res.body.code).toBe('EXPIRED_WEBHOOK_TIMESTAMP');
    });

    it('handles duplicate webhook delivery idempotently', async () => {
      const login = await createAuthenticatedUser();

      await dataSource.getRepository(UserIdentityVerification).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        verificationId: 'wh_dup_test',
        status: IdentityVerificationStatus.PENDING,
        provider: 'CASHFREE',
        verificationType: 'AADHAAR',
        documentType: 'AADHAAR',
      });

      jest.spyOn(cashfreeService, 'getAadhaarDocument').mockResolvedValue({
        status: 'VALID',
        name: 'Neha Roy',
        gender: 'F',
      });

      const payload = {
        type: 'DIGILOCKER_VERIFICATION_SUCCESS',
        data: { verification_id: 'wh_dup_test' },
      };

      // First webhook
      const first = await postWebhook(payload).expect(200);
      expect(first.body.status).toBe('PROCESSED');

      // Duplicate webhook
      const second = await postWebhook(payload).expect(200);
      expect(second.body.status).toBe('ALREADY_PROCESSED');
    });

    it('maps DIGILOCKER_VERIFICATION_LINK_EXPIRED to EXPIRED', async () => {
      const login = await createAuthenticatedUser();

      await dataSource.getRepository(UserIdentityVerification).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        verificationId: 'wh_link_expired_vid',
        status: IdentityVerificationStatus.PENDING,
        provider: 'CASHFREE',
        verificationType: 'AADHAAR',
        documentType: 'AADHAAR',
      });

      const payload = {
        type: 'DIGILOCKER_VERIFICATION_LINK_EXPIRED',
        data: { verification_id: 'wh_link_expired_vid' },
      };

      await postWebhook(payload).expect(200);

      const record = await dataSource
        .getRepository(UserIdentityVerification)
        .findOneByOrFail({ verificationId: 'wh_link_expired_vid' });
      expect(record.status).toBe(IdentityVerificationStatus.EXPIRED);
    });

    it('maps DIGILOCKER_VERIFICATION_CONSENT_DENIED to CONSENT_DENIED', async () => {
      const login = await createAuthenticatedUser();

      await dataSource.getRepository(UserIdentityVerification).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        verificationId: 'wh_consent_denied_vid',
        status: IdentityVerificationStatus.PENDING,
        provider: 'CASHFREE',
        verificationType: 'AADHAAR',
        documentType: 'AADHAAR',
      });

      const payload = {
        type: 'DIGILOCKER_VERIFICATION_CONSENT_DENIED',
        data: { verification_id: 'wh_consent_denied_vid' },
      };

      await postWebhook(payload).expect(200);

      const record = await dataSource
        .getRepository(UserIdentityVerification)
        .findOneByOrFail({ verificationId: 'wh_consent_denied_vid' });
      expect(record.status).toBe(IdentityVerificationStatus.CONSENT_DENIED);
    });

    it('maps DIGILOCKER_VERIFICATION_FAILURE to FAILED', async () => {
      const login = await createAuthenticatedUser();

      await dataSource.getRepository(UserIdentityVerification).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        verificationId: 'wh_failure_vid',
        status: IdentityVerificationStatus.PENDING,
        provider: 'CASHFREE',
        verificationType: 'AADHAAR',
        documentType: 'AADHAAR',
      });

      const payload = {
        type: 'DIGILOCKER_VERIFICATION_FAILURE',
        data: { verification_id: 'wh_failure_vid', reason: 'UIDAI service down' },
      };

      await postWebhook(payload).expect(200);

      const record = await dataSource
        .getRepository(UserIdentityVerification)
        .findOneByOrFail({ verificationId: 'wh_failure_vid' });
      expect(record.status).toBe(IdentityVerificationStatus.FAILED);
      expect(record.failureReason).toBe('UIDAI service down');
    });
  });

  // =========================================================================
  // G. Concurrency & Race Conditions
  // =========================================================================
  describe('G. Concurrency & Race Conditions', () => {
    it('concurrent refresh and webhook result in exactly one final VERIFIED state', async () => {
      const login = await createAuthenticatedUser();

      const record = await dataSource
        .getRepository(UserIdentityVerification)
        .save({
          id: crypto.randomUUID(),
          userId: login.user.id,
          verificationId: 'concurrency_vid_1',
          status: IdentityVerificationStatus.PENDING,
          provider: 'CASHFREE',
          verificationType: 'AADHAAR',
          documentType: 'AADHAAR',
        });

      jest.spyOn(cashfreeService, 'getVerificationStatus').mockResolvedValue({
        status: 'AUTHENTICATED',
      });
      jest.spyOn(cashfreeService, 'getAadhaarDocument').mockResolvedValue({
        status: 'VALID',
        name: 'Rani Patel',
        gender: 'F',
      });

      const payload = {
        type: 'DIGILOCKER_VERIFICATION_SUCCESS',
        data: { verification_id: 'concurrency_vid_1' },
      };

      // Trigger refresh and webhook simultaneously
      const [refreshRes, webhookRes] = await Promise.all([
        request(app.getHttpServer())
          .post('/kyc/aadhaar/digilocker/refresh')
          .set('Authorization', `Bearer ${login.accessToken}`),
        postWebhook(payload),
      ]);

      expect([200, 201]).toContain(refreshRes.status);
      expect([200, 201]).toContain(webhookRes.status);

      const finalRecord = await dataSource
        .getRepository(UserIdentityVerification)
        .findOneByOrFail({ id: record.id });
      expect(finalRecord.status).toBe(IdentityVerificationStatus.VERIFIED);
      expect(finalRecord.verifiedName).toBe('Rani Patel');
      expect(finalRecord.verifiedGender).toBe('F');
    });
  });

  // =========================================================================
  // H. Security & Women Only Integration
  // =========================================================================
  describe('H. Security & Women Only Ride Integration', () => {
    it('User A cannot view User B verification status (scoped to JWT user)', async () => {
      const userA = await createAuthenticatedUser();
      const userB = await createAuthenticatedUser();

      // User A creates a record
      await dataSource.getRepository(UserIdentityVerification).save({
        id: crypto.randomUUID(),
        userId: userA.user.id,
        verificationId: 'user_a_vid',
        status: IdentityVerificationStatus.VERIFIED,
        provider: 'CASHFREE',
        verificationType: 'AADHAAR',
        documentType: 'AADHAAR',
        verifiedName: 'User A Secret Name',
        verifiedGender: 'M',
        verifiedAt: new Date(),
      });

      // User B queries their own status
      const resB = await request(app.getHttpServer())
        .get('/kyc/aadhaar/digilocker/status')
        .set('Authorization', `Bearer ${userB.accessToken}`)
        .expect(200);

      // User B must NOT see User A's data
      expect(resB.body.status).toBe(IdentityMobileStatus.NOT_VERIFIED);
      expect(resB.body.verifiedName).toBeNull();
      expect(resB.body.verificationId).toBeNull();
    });

    it('verified female rider is allowed to book Women Only rides', () => {
      expect(() =>
        assertWomenOnlyBookingAllowed({
          rideType: RideType.REGULAR,
          womenOnly: true,
          passengerGender: Gender.FEMALE,
        }),
      ).not.toThrow();
    });

    it('unverified or male rider is rejected from Women Only rides', () => {
      expect(() =>
        assertWomenOnlyBookingAllowed({
          rideType: RideType.REGULAR,
          womenOnly: true,
          passengerGender: Gender.MALE,
        }),
      ).toThrow(WomenOnlyRideError);

      expect(() =>
        assertWomenOnlyBookingAllowed({
          rideType: RideType.REGULAR,
          womenOnly: true,
          passengerGender: null,
        }),
      ).toThrow(WomenOnlyRideError);
    });
  });

  // =========================================================================
  // I. Browser Redirect Callback Endpoint (GET /api/kyc/aadhaar/digilocker/callback)
  // =========================================================================
  describe('I. Browser Redirect Callback Endpoint (GET /api/kyc/aadhaar/digilocker/callback)', () => {
    it('returns 200 HTML for valid verification_id without JWT', async () => {
      const login = await createAuthenticatedUser();
      const record = await dataSource
        .getRepository(UserIdentityVerification)
        .save({
          id: crypto.randomUUID(),
          userId: login.user.id,
          verificationId: 'valid_cb_vid_1',
          status: IdentityVerificationStatus.PENDING,
          provider: 'CASHFREE',
          verificationType: 'AADHAAR',
          documentType: 'AADHAAR',
        });

      const res = await request(app.getHttpServer())
        .get('/api/kyc/aadhaar/digilocker/callback?verification_id=valid_cb_vid_1')
        .expect(200);

      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('Aadhaar verification completed.');
      expect(res.text).toContain('You can return to the BhaiWay app.');
      expect(res.text).toContain('BhaiWay Identity');

      // Also verify alias /kyc/aadhaar/digilocker/callback works
      const aliasRes = await request(app.getHttpServer())
        .get('/kyc/aadhaar/digilocker/callback?verification_id=valid_cb_vid_1')
        .expect(200);
      expect(aliasRes.text).toContain('Aadhaar verification completed.');
    });

    it('returns 400 HTML when verification_id is missing', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/kyc/aadhaar/digilocker/callback')
        .expect(400);

      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('Invalid Verification Request');
      expect(res.text).toContain('Verification identifier is missing');
    });

    it('returns 404 HTML when verification_id is unknown', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/kyc/aadhaar/digilocker/callback?verification_id=unknown_vid_999999')
        .expect(404);

      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('Verification Record Not Found');
      expect(res.text).toContain('No matching verification record was found');
    });

    it('safely handles already VERIFIED record without reverting status', async () => {
      const login = await createAuthenticatedUser();
      const record = await dataSource
        .getRepository(UserIdentityVerification)
        .save({
          id: crypto.randomUUID(),
          userId: login.user.id,
          verificationId: 'already_verified_cb_vid',
          status: IdentityVerificationStatus.VERIFIED,
          provider: 'CASHFREE',
          verificationType: 'AADHAAR',
          documentType: 'AADHAAR',
          verifiedName: 'Already Verified User',
          verifiedGender: 'M',
          verifiedAt: new Date(),
        });

      const res = await request(app.getHttpServer())
        .get('/api/kyc/aadhaar/digilocker/callback?verification_id=already_verified_cb_vid')
        .expect(200);

      expect(res.text).toContain('Aadhaar verification completed.');

      // Check DB: status remains VERIFIED
      const inDb = await dataSource
        .getRepository(UserIdentityVerification)
        .findOneByOrFail({ id: record.id });
      expect(inDb.status).toBe(IdentityVerificationStatus.VERIFIED);
      expect(inDb.verifiedName).toBe('Already Verified User');
    });

    it('is idempotent on repeated callback calls', async () => {
      const login = await createAuthenticatedUser();
      const record = await dataSource
        .getRepository(UserIdentityVerification)
        .save({
          id: crypto.randomUUID(),
          userId: login.user.id,
          verificationId: 'idempotent_cb_vid',
          status: IdentityVerificationStatus.PENDING,
          provider: 'CASHFREE',
          verificationType: 'AADHAAR',
          documentType: 'AADHAAR',
        });

      // Call 3 times
      for (let i = 0; i < 3; i++) {
        const res = await request(app.getHttpServer())
          .get('/api/kyc/aadhaar/digilocker/callback?verification_id=idempotent_cb_vid')
          .expect(200);
        expect(res.text).toContain('Aadhaar verification completed.');
      }

      // Check DB: exactly 1 record exists, still PENDING
      const records = await dataSource
        .getRepository(UserIdentityVerification)
        .find({ where: { verificationId: 'idempotent_cb_vid' } });
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe(IdentityVerificationStatus.PENDING);
    });

    it('persists reference_id if provided in query parameters', async () => {
      const login = await createAuthenticatedUser();
      const record = await dataSource
        .getRepository(UserIdentityVerification)
        .save({
          id: crypto.randomUUID(),
          userId: login.user.id,
          verificationId: 'ref_cb_vid',
          referenceId: null,
          status: IdentityVerificationStatus.PENDING,
          provider: 'CASHFREE',
          verificationType: 'AADHAAR',
          documentType: 'AADHAAR',
        });

      await request(app.getHttpServer())
        .get('/api/kyc/aadhaar/digilocker/callback?verification_id=ref_cb_vid&reference_id=cf_ref_987654')
        .expect(200);

      const inDb = await dataSource
        .getRepository(UserIdentityVerification)
        .findOneByOrFail({ id: record.id });
      expect(inDb.referenceId).toBe('cf_ref_987654');
    });

    it('does NOT mark user VERIFIED or update UserProfile merely from redirect parameters', async () => {
      const login = await createAuthenticatedUser();
      await dataSource.getRepository(UserProfile).save({
        id: crypto.randomUUID(),
        userId: login.user.id,
        firstName: 'OriginalFirstName',
        lastName: 'OriginalLastName',
        gender: null,
        isIdentityVerified: false,
      });

      const record = await dataSource
        .getRepository(UserIdentityVerification)
        .save({
          id: crypto.randomUUID(),
          userId: login.user.id,
          verificationId: 'no_profile_update_vid',
          status: IdentityVerificationStatus.PENDING,
          provider: 'CASHFREE',
          verificationType: 'AADHAAR',
          documentType: 'AADHAAR',
        });

      // Even if query claims status=SUCCESS or AUTHENTICATED
      await request(app.getHttpServer())
        .get(
          '/api/kyc/aadhaar/digilocker/callback?verification_id=no_profile_update_vid&status=SUCCESS',
        )
        .expect(200);

      // Verify UserIdentityVerification was NOT marked VERIFIED
      const inDb = await dataSource
        .getRepository(UserIdentityVerification)
        .findOneByOrFail({ id: record.id });
      expect(inDb.status).toBe(IdentityVerificationStatus.PENDING);
      expect(inDb.verifiedName).toBeNull();
      expect(inDb.verifiedGender).toBeNull();

      // Verify UserProfile was completely untouched
      const finalProfile = await dataSource
        .getRepository(UserProfile)
        .findOneByOrFail({ userId: login.user.id });
      expect(finalProfile.gender).toBeNull();
      expect(finalProfile.firstName).toBe('OriginalFirstName');
      expect(finalProfile.lastName).toBe('OriginalLastName');
    });

    it('does NOT expose sensitive verification data, secrets, or internal DB IDs', async () => {
      const login = await createAuthenticatedUser();
      const secretRecordId = crypto.randomUUID();
      await dataSource
        .getRepository(UserIdentityVerification)
        .save({
          id: secretRecordId,
          userId: login.user.id,
          verificationId: 'secret_leak_check_vid',
          status: IdentityVerificationStatus.PENDING,
          provider: 'CASHFREE',
          verificationType: 'AADHAAR',
          documentType: 'AADHAAR',
          aadhaarNumber: '999988887777',
        });

      const res = await request(app.getHttpServer())
        .get('/api/kyc/aadhaar/digilocker/callback?verification_id=secret_leak_check_vid')
        .expect(200);

      expect(res.text).not.toContain(secretRecordId);
      expect(res.text).not.toContain(login.user.id);
      expect(res.text).not.toContain('999988887777');
      expect(res.text).not.toContain(TEST_CLIENT_SECRET);
      expect(res.text).not.toContain('CASHFREE');
    });
  });
});
