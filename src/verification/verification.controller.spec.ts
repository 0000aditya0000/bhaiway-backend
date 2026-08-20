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
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';
import { UserVerification } from './entities/user-verification.entity';
import {
  VerificationStatus,
  VerificationType,
} from './enums/verification.enums';
import { VerificationModule } from './verification.module';
import { VerificationService } from './verification.service';

describe('VerificationModule (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  const tracked: TestWalletContext[] = [];
  const otpProvider = {
    verifyAccessToken: jest
      .fn()
      .mockRejectedValue(new Msg91ResponseFormatError()),
  };

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
        WalletModule,
        VerificationModule,
      ],
    })
      .overrideProvider(OTP_PROVIDER)
      .useValue(otpProvider)
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
    verificationService = moduleRef.get(VerificationService);
  });

  afterEach(async () => {
    otpProvider.verifyAccessToken.mockClear();
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await dataSource.getRepository(UserVerification).delete({
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

  async function currentRecord(userId: string, type: VerificationType) {
    return dataSource.getRepository(UserVerification).findOneByOrFail({
      userId,
      verificationType: type,
      isCurrent: true,
    });
  }

  it('unauthenticated GET /verification/me → 401', async () => {
    await request(app.getHttpServer()).get('/verification/me').expect(401);
  });

  it('authenticated GET /verification/me', async () => {
    const login = await createAuthenticatedUser();

    const response = await request(app.getHttpServer())
      .get('/verification/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(response.body).toEqual({
      identity: {
        status: VerificationStatus.PENDING,
        submittedAt: null,
        verifiedAt: null,
        rejectedAt: null,
        rejectionReason: null,
        expiresAt: null,
      },
      drivingLicense: {
        status: VerificationStatus.PENDING,
        submittedAt: null,
        verifiedAt: null,
        rejectedAt: null,
        rejectionReason: null,
        expiresAt: null,
      },
      vehicle: {
        status: VerificationStatus.PENDING,
        submittedAt: null,
        verifiedAt: null,
        rejectedAt: null,
        rejectionReason: null,
        expiresAt: null,
      },
    });
  });

  it('new user has pending/unsubmitted verification state', async () => {
    const login = await createAuthenticatedUser();

    const count = await dataSource.getRepository(UserVerification).count({
      where: { userId: login.user.id },
    });
    expect(count).toBe(0);

    const me = await verificationService.getMyVerifications(login.user.id);
    expect(me.identity.status).toBe(VerificationStatus.PENDING);
    expect(me.drivingLicense.status).toBe(VerificationStatus.PENDING);
    expect(me.vehicle.status).toBe(VerificationStatus.PENDING);
  });

  it('submits identity verification as VERIFIED via stub provider', async () => {
    const login = await createAuthenticatedUser();

    const response = await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        documentUrl: 'https://cdn.example.com/id.pdf',
        documentType: 'IDENTITY_SCAN',
        documentReference: 'obj-id-1',
      })
      .expect(201);

    expect(response.body.status).toBe(VerificationStatus.VERIFIED);
    expect(response.body.submittedAt).toBeTruthy();
    expect(response.body.verifiedAt).toBeTruthy();
    expect(response.body.rejectedAt).toBeNull();
    expect(response.body.rejectionReason).toBeNull();
    expect(response.body.expiresAt).toBeNull();

    const record = await currentRecord(
      login.user.id,
      VerificationType.IDENTITY,
    );
    expect(record.status).toBe(VerificationStatus.VERIFIED);
    expect(record.provider).toBe('stub');
    expect(record.verifiedAt).toBeTruthy();
    expect(record.rejectedAt).toBeNull();
    expect(record.rejectionReason).toBeNull();
    expect(record.documentUrl).toBe('https://cdn.example.com/id.pdf');

    const me = await request(app.getHttpServer())
      .get('/verification/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(me.body.identity).toMatchObject({
      status: VerificationStatus.VERIFIED,
      rejectedAt: null,
      rejectionReason: null,
      expiresAt: null,
    });
    expect(me.body.identity.submittedAt).toBeTruthy();
    expect(me.body.identity.verifiedAt).toBeTruthy();
  });

  it('submits driving license verification as VERIFIED via stub provider', async () => {
    const login = await createAuthenticatedUser();

    const response = await request(app.getHttpServer())
      .post('/verification/driving-license')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'DL_SCAN' })
      .expect(201);

    expect(response.body.status).toBe(VerificationStatus.VERIFIED);
    expect(response.body.verifiedAt).toBeTruthy();

    const record = await currentRecord(
      login.user.id,
      VerificationType.DRIVING_LICENSE,
    );
    expect(record.verificationType).toBe(VerificationType.DRIVING_LICENSE);
    expect(record.status).toBe(VerificationStatus.VERIFIED);
    expect(record.provider).toBe('stub');
  });

  it('submits vehicle verification as VERIFIED via stub provider', async () => {
    const login = await createAuthenticatedUser();

    const response = await request(app.getHttpServer())
      .post('/verification/vehicle')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'RC_SCAN' })
      .expect(201);

    expect(response.body.status).toBe(VerificationStatus.VERIFIED);
    expect(response.body.verifiedAt).toBeTruthy();

    const record = await currentRecord(
      login.user.id,
      VerificationType.VEHICLE,
    );
    expect(record.verificationType).toBe(VerificationType.VEHICLE);
    expect(record.status).toBe(VerificationStatus.VERIFIED);
    expect(record.provider).toBe('stub');
  });

  it('stub bootstrap after identity submit verifies DL and vehicle in GET /verification/me', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN' })
      .expect(201);

    const me = await request(app.getHttpServer())
      .get('/verification/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(me.body.identity.status).toBe(VerificationStatus.VERIFIED);
    expect(me.body.drivingLicense.status).toBe(VerificationStatus.VERIFIED);
    expect(me.body.vehicle.status).toBe(VerificationStatus.VERIFIED);
    expect(me.body.drivingLicense.verifiedAt).toBeTruthy();
    expect(me.body.vehicle.verifiedAt).toBeTruthy();
  });

  it('stub bootstrap on GET /verification/me when identity already verified', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN' })
      .expect(201);

    await dataSource.getRepository(UserVerification).delete({
      userId: login.user.id,
      verificationType: VerificationType.DRIVING_LICENSE,
    });
    await dataSource.getRepository(UserVerification).delete({
      userId: login.user.id,
      verificationType: VerificationType.VEHICLE,
    });

    const me = await request(app.getHttpServer())
      .get('/verification/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(me.body.identity.status).toBe(VerificationStatus.VERIFIED);
    expect(me.body.drivingLicense.status).toBe(VerificationStatus.VERIFIED);
    expect(me.body.vehicle.status).toBe(VerificationStatus.VERIFIED);
  });

  it('canPublishRide() true after stub bootstrap from identity submit only', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN' })
      .expect(201);

    const result = await verificationService.canPublishRide(login.user.id);
    expect(result.allowed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('canPublishRide() still fails when a required verification is not VERIFIED', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN' })
      .expect(201);

    const dlRecord = await currentRecord(
      login.user.id,
      VerificationType.DRIVING_LICENSE,
    );
    await verificationService.applyTrustedVerificationDecision(dlRecord.id, {
      status: VerificationStatus.REJECTED,
      rejectionReason: 'Manual test rejection',
    });

    const result = await verificationService.canPublishRide(login.user.id);
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain(VerificationType.DRIVING_LICENSE);
  });

  it('cannot submit using another userId from the body', async () => {
    const userA = await createAuthenticatedUser();
    const userB = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ userId: userB.user.id, documentType: 'IDENTITY_SCAN' })
      .expect(400);

    const countB = await dataSource.getRepository(UserVerification).count({
      where: { userId: userB.user.id },
    });
    expect(countB).toBe(0);

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN' })
      .expect(201);

    const recordA = await currentRecord(
      userA.user.id,
      VerificationType.IDENTITY,
    );
    expect(recordA.userId).toBe(userA.user.id);
  });

  it('duplicate active submission rejected', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN' })
      .expect(409);
  });

  it('rejected verification can be resubmitted', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN', documentReference: 'first' })
      .expect(201);

    const first = await currentRecord(
      login.user.id,
      VerificationType.IDENTITY,
    );

    await verificationService.applyTrustedVerificationDecision(first.id, {
      status: VerificationStatus.REJECTED,
      rejectionReason: 'Unreadable document',
    });

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN', documentReference: 'second' })
      .expect(201);

    const current = await currentRecord(
      login.user.id,
      VerificationType.IDENTITY,
    );
    expect(current.id).not.toBe(first.id);
    expect(current.status).toBe(VerificationStatus.VERIFIED);
    expect(current.documentReference).toBe('second');

    const historical = await dataSource
      .getRepository(UserVerification)
      .findOneByOrFail({ id: first.id });
    expect(historical.isCurrent).toBe(false);
    expect(historical.status).toBe(VerificationStatus.REJECTED);
  });

  it('VERIFIED status cannot be faked through request DTO', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        documentType: 'IDENTITY_SCAN',
        status: VerificationStatus.VERIFIED,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN' })
      .expect(201);

    const record = await currentRecord(
      login.user.id,
      VerificationType.IDENTITY,
    );
    expect(record.status).toBe(VerificationStatus.VERIFIED);
  });

  it('client cannot send verified=true to control status', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        documentType: 'IDENTITY_SCAN',
        verified: true,
      })
      .expect(400);
  });

  it('client cannot set status', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/driving-license')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ status: 'VERIFIED' })
      .expect(400);
  });

  it('client cannot set verifiedAt', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/vehicle')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ verifiedAt: new Date().toISOString() })
      .expect(400);
  });

  it('client cannot set provider', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ provider: 'evil-provider' })
      .expect(400);
  });

  it('sensitive document fields are not returned', async () => {
    const login = await createAuthenticatedUser();

    const submitted = await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        documentUrl: 'https://cdn.example.com/secret.pdf',
        documentType: 'IDENTITY_SCAN',
        documentReference: 'secret-ref',
      })
      .expect(201);

    expect(submitted.body.documentUrl).toBeUndefined();
    expect(submitted.body.documentType).toBeUndefined();
    expect(submitted.body.documentReference).toBeUndefined();
    expect(submitted.body.provider).toBeUndefined();
    expect(submitted.body.providerReference).toBeUndefined();
    expect(submitted.body.aadhaarNumber).toBeUndefined();
    expect(submitted.body.drivingLicenseNumber).toBeUndefined();

    const me = await request(app.getHttpServer())
      .get('/verification/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(me.body.identity.documentUrl).toBeUndefined();
    expect(me.body.identity.providerReference).toBeUndefined();
  });

  it('canPublishRide() false when required verification missing', async () => {
    const login = await createAuthenticatedUser();

    const result = await verificationService.canPublishRide(login.user.id);
    expect(result.allowed).toBe(false);
    expect(result.missing).toEqual([
      VerificationType.IDENTITY,
      VerificationType.DRIVING_LICENSE,
      VerificationType.VEHICLE,
    ]);
    expect(result.vehicleEligible).toBeNull();
  });

  it('canPublishRide() true only when required verification states are VERIFIED', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN' })
      .expect(201);

    const result = await verificationService.canPublishRide(login.user.id);
    expect(result.allowed).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.vehicleEligible).toBeNull();
  });

  it('canBookRide() false when identity is not VERIFIED', async () => {
    const login = await createAuthenticatedUser();

    const result = await verificationService.canBookRide(login.user.id);
    expect(result.allowed).toBe(false);
    expect(result.missing).toEqual([VerificationType.IDENTITY]);
    expect(result.vehicleEligible).toBeNull();
  });

  it('canBookRide() true when identity is VERIFIED', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN' })
      .expect(201);

    const result = await verificationService.canBookRide(login.user.id);
    expect(result.allowed).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.vehicleEligible).toBeNull();
  });

  it('does not call MSG91 when submitting identity verification', async () => {
    const login = await createAuthenticatedUser();
    otpProvider.verifyAccessToken.mockClear();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN' })
      .expect(201);

    expect(otpProvider.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('trusted decision still supports REJECTED, IN_REVIEW, and EXPIRED', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN' })
      .expect(201);

    const record = await currentRecord(
      login.user.id,
      VerificationType.IDENTITY,
    );

    const inReview = await verificationService.applyTrustedVerificationDecision(
      record.id,
      { status: VerificationStatus.IN_REVIEW },
    );
    expect(inReview.status).toBe(VerificationStatus.IN_REVIEW);

    const rejected = await verificationService.applyTrustedVerificationDecision(
      record.id,
      {
        status: VerificationStatus.REJECTED,
        rejectionReason: 'Mismatch',
      },
    );
    expect(rejected.status).toBe(VerificationStatus.REJECTED);
    expect(rejected.rejectedAt).toBeTruthy();
    expect(rejected.rejectionReason).toBe('Mismatch');

    const expired = await verificationService.applyTrustedVerificationDecision(
      record.id,
      { status: VerificationStatus.EXPIRED },
    );
    expect(expired.status).toBe(VerificationStatus.EXPIRED);
  });
});
