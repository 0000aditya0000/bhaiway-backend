import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { UserProfile } from '../users/entities/user-profile.entity';
import { CashfreeConfigService } from '../verification/cashfree/cashfree.config';
import {
  CashfreeApiError,
  CashfreeRateLimitError,
  VehicleRcForbiddenError,
  VehicleRcInvalidError,
} from '../verification/cashfree/cashfree.errors';
import { CashfreeVehicleRcService } from '../verification/cashfree/cashfree-vehicle-rc.service';
import { UserIdentityVerification } from '../verification/entities/user-identity-verification.entity';
import { UserVerification } from '../verification/entities/user-verification.entity';
import { VehicleRcVerification } from '../verification/entities/vehicle-rc-verification.entity';
import { IdentityVerificationStatus } from '../verification/enums/identity-verification.enums';
import {
  VehicleOwnerMatchStatus,
  VehicleRcVerificationStatus,
} from '../verification/enums/vehicle-rc-verification.enums';
import {
  VerificationStatus,
  VerificationType,
} from '../verification/enums/verification.enums';
import { VerificationModule } from '../verification/verification.module';
import { VerificationService } from '../verification/verification.service';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';
import { Vehicle } from './entities/vehicle.entity';
import { VehicleType } from './enums/vehicle-type.enum';
import { VehiclesModule } from './vehicles.module';
import { VehiclesService } from './vehicles.service';

describe('Cashfree Vehicle RC Verification', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let vehiclesService: VehiclesService;
  let verificationService: VerificationService;
  let cashfreeRcService: CashfreeVehicleRcService;
  let cashfreeConfigService: CashfreeConfigService;
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
        WalletModule,
        VerificationModule,
        VehiclesModule,
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
    vehiclesService = moduleRef.get(VehiclesService);
    verificationService = moduleRef.get(VerificationService);
    cashfreeRcService = moduleRef.get(CashfreeVehicleRcService);
    cashfreeConfigService = moduleRef.get(CashfreeConfigService);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await dataSource
          .getRepository(VehicleRcVerification)
          .delete({ userId: ctx.userId });
        await dataSource.getRepository(Vehicle).delete({ userId: ctx.userId });
        await dataSource
          .getRepository(UserIdentityVerification)
          .delete({ userId: ctx.userId });
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

  async function createAuthenticatedUser(name = 'Ramesh Kumar') {
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

    // Set user profile name
    const [firstName, ...rest] = name.split(' ');
    const profileRepo = dataSource.getRepository(UserProfile);
    let profile = await profileRepo.findOne({
      where: { userId: login.user.id },
    });
    if (!profile) {
      profile = profileRepo.create({
        userId: login.user.id,
        firstName,
        lastName: rest.join(' ') || null,
        displayName: name,
      });
    } else {
      profile.firstName = firstName;
      profile.lastName = rest.join(' ') || null;
      profile.displayName = name;
    }
    await profileRepo.save(profile);

    tracked.push({
      userId: login.user.id,
      walletId: wallet.id,
      balanceId: balance.id,
      phone,
    });

    return login;
  }

  function uniqueRegistration(prefix = 'DL01') {
    const suffix = `${Date.now().toString().slice(-4)}${Math.floor(
      Math.random() * 100,
    )
      .toString()
      .padStart(2, '0')}`;
    return `${prefix}AB${suffix}`;
  }

  async function createTestVehicle(
    userId: string,
    registrationNumber = uniqueRegistration(),
  ) {
    const repo = dataSource.getRepository(Vehicle);
    const vehicle = repo.create({
      userId,
      vehicleType: VehicleType.CAR,
      make: 'Hyundai',
      model: 'i20',
      variant: 'Asta',
      registrationNumber,
      registrationYear: 2023,
      color: 'White',
      seatingCapacity: 5,
      isActive: true,
    });
    return repo.save(vehicle);
  }

  // =========================================================================
  // 1. CashfreeVehicleRcService Unit Tests
  // =========================================================================
  describe('CashfreeVehicleRcService', () => {
    beforeEach(() => {
      jest.spyOn(cashfreeConfigService, 'getConfig').mockReturnValue({
        environment: 'production',
        baseUrl: 'https://api.cashfree.com/verification',
        clientId: 'mock-client-id',
        clientSecret: 'mock-client-secret',
        redirectUrl: 'https://example.com/callback',
        timeoutMs: 5000,
      });
    });

    it('1. Normalizes vehicle registration number correctly', () => {
      expect(cashfreeRcService.normalizeVehicleNumber(' dl 01 - ab 1234 ')).toBe(
        'DL01AB1234',
      );
      expect(cashfreeRcService.normalizeVehicleNumber('up-14-bc-9999')).toBe(
        'UP14BC9999',
      );
      expect(cashfreeRcService.normalizeVehicleNumber('mh 02 cl 4321')).toBe(
        'MH02CL4321',
      );
    });

    it('2. Validates verification ID: rejects missing, too long (>50), or invalid characters', () => {
      expect(() => cashfreeRcService.validateVerificationId('')).toThrow(
        BadRequestException,
      );
      expect(() =>
        cashfreeRcService.validateVerificationId('a'.repeat(51)),
      ).toThrow(BadRequestException);
      expect(() =>
        cashfreeRcService.validateVerificationId('invalid id with spaces'),
      ).toThrow(BadRequestException);
      expect(() =>
        cashfreeRcService.validateVerificationId('invalid@special#id'),
      ).toThrow(BadRequestException);

      // Valid IDs
      expect(() =>
        cashfreeRcService.validateVerificationId('rc_12345_abc.def-ghi'),
      ).not.toThrow();
    });

    it('3. Generates server-side verification ID <= 50 chars with alphanumeric/underscore/dot', () => {
      const vId = vehiclesService.generateRcVerificationId(
        'a0000000-0000-0000-0000-000000000001',
      );
      expect(vId.length).toBeLessThanOrEqual(50);
      expect(/^[a-zA-Z0-9._-]+$/.test(vId)).toBe(true);
      expect(vId.startsWith('rc_')).toBe(true);
    });

    it('4. Uses production vehicle-rc endpoint', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'VALID',
          verification_id: 'test_prod_1',
          reg_no: 'DL01AB1234',
        }),
      } as any);

      jest.spyOn(cashfreeConfigService, 'getConfig').mockReturnValueOnce({
        environment: 'production',
        baseUrl: 'https://api.cashfree.com/verification',
        clientId: 'prod-client-id',
        clientSecret: 'prod-client-secret',
        redirectUrl: 'https://example.com/callback',
        timeoutMs: 5000,
      });

      await cashfreeRcService.verifyVehicleRc({
        verificationId: 'test_prod_1',
        vehicleNumber: 'DL01AB1234',
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.cashfree.com/verification/vehicle-rc',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-client-id': 'prod-client-id',
            'x-client-secret': 'prod-client-secret',
          }),
        }),
      );
    });

    it('5. Maps Cashfree 400 Bad Request', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          code: 'vehicle_rc_value_invalid',
          message: 'Vehicle registration number is invalid',
        }),
      } as any);

      await expect(
        cashfreeRcService.verifyVehicleRc({
          verificationId: 'rc_test_400',
          vehicleNumber: 'DL01AB1234',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('7. Maps Cashfree 401 Unauthorized to CashfreeApiError', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({
          code: 'authentication_failed',
          message: 'Client authentication failed',
        }),
      } as any);

      await expect(
        cashfreeRcService.verifyVehicleRc({
          verificationId: 'rc_test_401',
          vehicleNumber: 'DL01AB1234',
        }),
      ).rejects.toThrow(CashfreeApiError);
    });

    it('8. Maps Cashfree 403 Forbidden to CashfreeApiError', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({
          code: 'ip_validation_failed',
          message: 'IP whitelist verification failed',
        }),
      } as any);

      await expect(
        cashfreeRcService.verifyVehicleRc({
          verificationId: 'rc_test_403',
          vehicleNumber: 'DL01AB1234',
        }),
      ).rejects.toThrow(CashfreeApiError);
    });

    it('9. Maps Cashfree 409 Conflict (duplicate verification_id)', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          code: 'verification_id_already_exists',
          message: 'Verification ID already exists',
        }),
      } as any);

      await expect(
        cashfreeRcService.verifyVehicleRc({
          verificationId: 'rc_test_409',
          vehicleNumber: 'DL01AB1234',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('10. Maps Cashfree 422 insufficient_balance to CashfreeApiError', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({
          code: 'insufficient_balance',
          message: 'Insufficient balance in wallet',
        }),
      } as any);

      await expect(
        cashfreeRcService.verifyVehicleRc({
          verificationId: 'rc_test_422_bal',
          vehicleNumber: 'DL01AB1234',
        }),
      ).rejects.toThrow(CashfreeApiError);
    });

    it('11. Maps Cashfree 429 Rate Limit to CashfreeRateLimitError', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({
          code: 'too_many_requests_per_operation',
          message: 'Rate limit exceeded',
        }),
      } as any);

      await expect(
        cashfreeRcService.verifyVehicleRc({
          verificationId: 'rc_test_429',
          vehicleNumber: 'DL01AB1234',
        }),
      ).rejects.toThrow(CashfreeRateLimitError);
    });

    it('12. Maps Cashfree 500 and 502 to CashfreeApiError', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({
          code: 'internal_error',
          message: 'Internal server error',
        }),
      } as any);

      await expect(
        cashfreeRcService.verifyVehicleRc({
          verificationId: 'rc_test_500',
          vehicleNumber: 'DL01AB1234',
        }),
      ).rejects.toThrow(CashfreeApiError);

      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({
          code: 'bad_gateway',
          message: 'Gateway error',
        }),
      } as any);

      await expect(
        cashfreeRcService.verifyVehicleRc({
          verificationId: 'rc_test_502',
          vehicleNumber: 'DL01AB1234',
        }),
      ).rejects.toThrow(CashfreeApiError);
    });

    it('13. Client secret is never exposed in returned error message', async () => {
      const secret = 'SUPER_SECRET_KEY_12345';
      jest.spyOn(cashfreeConfigService, 'getConfig').mockReturnValueOnce({
        environment: 'production',
        baseUrl: 'https://api.cashfree.com/verification',
        clientId: 'my-client-id',
        clientSecret: secret,
        redirectUrl: 'https://example.com',
        timeoutMs: 5000,
      });

      jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network drop'));

      try {
        await cashfreeRcService.verifyVehicleRc({
          verificationId: 'rc_test_sec',
          vehicleNumber: 'DL01AB1234',
        });
        fail('Should have thrown error');
      } catch (err: any) {
        expect(err.message).not.toContain(secret);
        expect(JSON.stringify(err)).not.toContain(secret);
      }
    });
  });

  // =========================================================================
  // 2. VehiclesService & Controller Integration Tests (POST /vehicles/:id/verify-rc)
  // =========================================================================
  describe('POST /vehicles/:id/verify-rc', () => {
    it('14. Valid RC verification returns 200, updates vehicle & user_verifications to VERIFIED', async () => {
      const login = await createAuthenticatedUser('Ramesh Kumar');
      const vehicle = await createTestVehicle(login.user.id, 'DL01AB1234');

      jest.spyOn(cashfreeRcService, 'verifyVehicleRc').mockResolvedValueOnce({
        verificationId: 'rc_valid_test_1',
        referenceId: 'ref_12345',
        status: 'VALID',
        regNo: 'DL01AB1234',
        class: 'Motor Car (LMV)',
        chassis: '***1234',
        engine: '***5678',
        vehicleManufacturerName: 'Hyundai',
        model: 'i20',
        vehicleColor: 'White',
        owner: 'Ramesh Kumar',
        rcStatus: 'ACTIVE',
        seatCapacity: 5,
        isCommercial: false,
      });

      const res = await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ vehicleNumber: 'DL 01 AB 1234' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.verification.status).toBe('VERIFIED');
      expect(res.body.verification.vehicleNumber).toBe('DL01AB1234');
      expect(res.body.verification.ownerMatchStatus).toBe(
        VehicleOwnerMatchStatus.MATCHED,
      );

      // Verify Vehicle table updated
      const updatedVehicle = await dataSource
        .getRepository(Vehicle)
        .findOneByOrFail({ id: vehicle.id });
      expect(updatedVehicle.documentType).toBe('RC');
      expect(updatedVehicle.documentReference).toBeDefined();

      // Verify UserVerification table updated
      const userVerif = await dataSource
        .getRepository(UserVerification)
        .findOneByOrFail({
          userId: login.user.id,
          verificationType: VerificationType.VEHICLE,
          isCurrent: true,
        });
      expect(userVerif.status).toBe(VerificationStatus.VERIFIED);
      expect(userVerif.provider).toBe('CASHFREE');
      expect(userVerif.documentType).toBe('RC');

      // Verify immutable vehicle_rc_verifications row created
      const rcRecord = await dataSource
        .getRepository(VehicleRcVerification)
        .findOneByOrFail({ vehicleId: vehicle.id });
      expect(rcRecord.status).toBe(VehicleRcVerificationStatus.VALID);
      expect(rcRecord.ownerMatchStatus).toBe(VehicleOwnerMatchStatus.MATCHED);
      expect(rcRecord.manufacturerName).toBe('Hyundai');
    });

    it('15. Invalid RC verification returns 422 VEHICLE_RC_INVALID and does NOT verify vehicle', async () => {
      const login = await createAuthenticatedUser();
      const vehicle = await createTestVehicle(login.user.id, 'DL01INVALID1');

      jest.spyOn(cashfreeRcService, 'verifyVehicleRc').mockResolvedValueOnce({
        verificationId: 'rc_invalid_test_1',
        status: 'INVALID',
        regNo: 'DL01INVALID1',
        failureCode: 'VEHICLE_RC_INVALID',
        failureReason: 'RC details not found in registry',
      });

      const res = await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ vehicleNumber: 'DL01INVALID1' })
        .expect(422);

      expect(res.body.code).toBe('VEHICLE_RC_INVALID');

      // Vehicle should NOT be marked verified
      const updatedVehicle = await dataSource
        .getRepository(Vehicle)
        .findOneByOrFail({ id: vehicle.id });
      expect(updatedVehicle.documentType).toBeNull();

      // UserVerification should NOT be verified
      const userVerif = await dataSource
        .getRepository(UserVerification)
        .findOne({
          where: {
            userId: login.user.id,
            verificationType: VerificationType.VEHICLE,
            isCurrent: true,
          },
        });
      expect(userVerif?.status).not.toBe(VerificationStatus.VERIFIED);

      // Audited as INVALID
      const rcRecord = await dataSource
        .getRepository(VehicleRcVerification)
        .findOneByOrFail({ vehicleId: vehicle.id });
      expect(rcRecord.status).toBe(VehicleRcVerificationStatus.INVALID);
      expect(rcRecord.failureCode).toBe('VEHICLE_RC_INVALID');
    });

    it('16. Registration number mismatch between requested and returned fails with 422', async () => {
      const login = await createAuthenticatedUser();
      const vehicle = await createTestVehicle(login.user.id, 'DL01AB1111');

      jest.spyOn(cashfreeRcService, 'verifyVehicleRc').mockResolvedValueOnce({
        verificationId: 'rc_mismatch_1',
        status: 'VALID',
        regNo: 'UP14CD9999', // returned does not match requested DL01AB1111
      });

      const res = await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ vehicleNumber: 'DL01AB1111' })
        .expect(422);

      expect(res.body.code).toBe('VEHICLE_NUMBER_MISMATCH');

      // Check saved audit record
      const rcRecord = await dataSource
        .getRepository(VehicleRcVerification)
        .findOneByOrFail({ vehicleId: vehicle.id });
      expect(rcRecord.status).toBe(VehicleRcVerificationStatus.INVALID);
      expect(rcRecord.failureCode).toBe('VEHICLE_NUMBER_MISMATCH');
    });

    it('17. Fallback to vehicle.registrationNumber when vehicleNumber omitted in body', async () => {
      const login = await createAuthenticatedUser();
      const vehicle = await createTestVehicle(login.user.id, 'HR26DK8888');

      const verifySpy = jest
        .spyOn(cashfreeRcService, 'verifyVehicleRc')
        .mockResolvedValueOnce({
          verificationId: 'rc_fallback_1',
          status: 'VALID',
          regNo: 'HR26DK8888',
        });

      const res = await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({}) // empty body
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(verifySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          vehicleNumber: 'HR26DK8888',
        }),
      );
    });

    it('18. Rejects invalid vehicle number format in request body with 400', async () => {
      const login = await createAuthenticatedUser();
      const vehicle = await createTestVehicle(login.user.id);

      await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ vehicleNumber: 'DL@#$%' }) // invalid symbols
        .expect(400);

      await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ vehicleNumber: 'AB' }) // too short (< 4)
        .expect(400);
    });

    it('19. Idempotency: duplicate verification returns existing without extra Cashfree call', async () => {
      const login = await createAuthenticatedUser();
      const vehicle = await createTestVehicle(login.user.id, 'MH02CL5555');

      const verifySpy = jest
        .spyOn(cashfreeRcService, 'verifyVehicleRc')
        .mockResolvedValueOnce({
          verificationId: 'rc_idempotent_1',
          status: 'VALID',
          regNo: 'MH02CL5555',
        });

      // First call
      await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ vehicleNumber: 'MH02CL5555' })
        .expect(200);

      expect(verifySpy).toHaveBeenCalledTimes(1);

      // Second call for the same vehicle and number
      const secondRes = await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ vehicleNumber: 'MH02CL5555' })
        .expect(200);

      // Cashfree API should NOT have been called a second time
      expect(verifySpy).toHaveBeenCalledTimes(1);
      expect(secondRes.body.verification.status).toBe('VERIFIED');
    });

    it('20. Re-verification allowed when registration number changes or previous status was INVALID', async () => {
      const login = await createAuthenticatedUser();
      const vehicle = await createTestVehicle(login.user.id, 'DL01REVERIF1');

      const verifySpy = jest
        .spyOn(cashfreeRcService, 'verifyVehicleRc')
        .mockResolvedValueOnce({
          verificationId: 'rc_first_fail',
          status: 'INVALID',
          regNo: 'DL01REVERIF1',
        })
        .mockResolvedValueOnce({
          verificationId: 'rc_second_success',
          status: 'VALID',
          regNo: 'DL01REVERIF1',
        });

      // First call: returns INVALID
      await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ vehicleNumber: 'DL01REVERIF1' })
        .expect(422);

      // Second call: now returns VALID
      const res = await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ vehicleNumber: 'DL01REVERIF1' })
        .expect(200);

      expect(verifySpy).toHaveBeenCalledTimes(2);
      expect(res.body.verification.status).toBe('VERIFIED');
    });

    it('21. Authorization: User A cannot verify User B vehicle (403 Forbidden)', async () => {
      const userA = await createAuthenticatedUser('User A');
      const userB = await createAuthenticatedUser('User B');
      const vehicleB = await createTestVehicle(userB.user.id, 'UP16CD1234');

      const res = await request(app.getHttpServer())
        .post(`/vehicles/${vehicleB.id}/verify-rc`)
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ vehicleNumber: 'UP16CD1234' })
        .expect(403);

      expect(res.body.code).toBe('VEHICLE_ACCESS_DENIED');
    });

    it('22. Unauthenticated request rejected with 401', async () => {
      const user = await createAuthenticatedUser();
      const vehicle = await createTestVehicle(user.user.id);

      await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .send({ vehicleNumber: vehicle.registrationNumber })
        .expect(401);
    });

    it('23. Non-existent vehicle ID returns 404', async () => {
      const login = await createAuthenticatedUser();

      await request(app.getHttpServer())
        .post('/vehicles/00000000-0000-0000-0000-000000000000/verify-rc')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ vehicleNumber: 'DL01AB1234' })
        .expect(404);
    });

    it('24. Owner info comparison sets ownerMatchStatus correctly without overwriting user name', async () => {
      const login = await createAuthenticatedUser('Aditya Sharma');
      const vehicle = await createTestVehicle(login.user.id, 'KA01AB4321');

      // Cashfree returns different owner name
      jest.spyOn(cashfreeRcService, 'verifyVehicleRc').mockResolvedValueOnce({
        verificationId: 'rc_owner_diff',
        status: 'VALID',
        regNo: 'KA01AB4321',
        owner: 'Suresh Patel',
      });

      const res = await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ vehicleNumber: 'KA01AB4321' })
        .expect(200);

      expect(res.body.verification.ownerMatchStatus).toBe(
        VehicleOwnerMatchStatus.NOT_MATCHED,
      );

      // Ensure UserProfile.name was NEVER overwritten
      const profile = await dataSource
        .getRepository(UserProfile)
        .findOneByOrFail({ userId: login.user.id });
      expect(profile.firstName).toBe('Aditya');
      expect(profile.lastName).toBe('Sharma');
    });

    it('25. Ride publishing guard (canPublishRide) requires verified vehicle RC', async () => {
      const login = await createAuthenticatedUser();
      const vehicle = await createTestVehicle(login.user.id, 'DL01PUBSH1');

      // Setup Identity as verified (DL remains unverified / optional)
      const userVerifRepo = dataSource.getRepository(UserVerification);
      await userVerifRepo.save(
        userVerifRepo.create({
          userId: login.user.id,
          verificationType: VerificationType.IDENTITY,
          status: VerificationStatus.VERIFIED,
          isCurrent: true,
          submittedAt: new Date(),
          verifiedAt: new Date(),
        }),
      );

      // Before RC verification: canPublishRide must be false
      let eligibility = await verificationService.canPublishRide(
        login.user.id,
        vehicle.id,
      );
      expect(eligibility.allowed).toBe(false);
      expect(eligibility.missing).toEqual([VerificationType.VEHICLE]);

      // Perform RC verification
      jest.spyOn(cashfreeRcService, 'verifyVehicleRc').mockResolvedValueOnce({
        verificationId: 'rc_publish_success',
        status: 'VALID',
        regNo: 'DL01PUBSH1',
      });

      await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ vehicleNumber: 'DL01PUBSH1' })
        .expect(200);

      // After successful RC verification: canPublishRide must be true
      eligibility = await verificationService.canPublishRide(
        login.user.id,
        vehicle.id,
      );
      expect(eligibility.allowed).toBe(true);
      expect(eligibility.missing).toEqual([]);
    });
  });
});
