/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await */
import {
  BadRequestException,
  ConflictException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
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
} from '../verification/cashfree/cashfree.errors';
import {
  CashfreeVehicleRcApiResponse,
  CashfreeVehicleRcService,
} from '../verification/cashfree/cashfree-vehicle-rc.service';
import { UserIdentityVerification } from '../verification/entities/user-identity-verification.entity';
import { UserVerification } from '../verification/entities/user-verification.entity';
import { VehicleRcVerification } from '../verification/entities/vehicle-rc-verification.entity';
import {
  PublicVehicleRcStatus,
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
    overrides: Partial<Vehicle> = {},
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
      ...overrides,
    });
    return repo.save(vehicle);
  }

  function matchingCashfreeRc(
    registrationNumber: string,
    overrides: Partial<CashfreeVehicleRcApiResponse> = {},
  ): CashfreeVehicleRcApiResponse {
    return {
      verificationId: `rc_${registrationNumber}`,
      status: 'VALID',
      regNo: registrationNumber,
      vehicleManufacturerName: 'Hyundai',
      model: 'i20',
      vehicleColor: 'White',
      class: 'Motor Car (LMV)',
      rcStatus: 'ACTIVE',
      vehicleInsuranceUpto: '2099-12-31',
      ...overrides,
    };
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
        publicKey: null,
        redirectUrl: 'https://example.com/callback',
        timeoutMs: 5000,
      });
    });

    it('1. Normalizes vehicle registration number correctly', () => {
      expect(
        cashfreeRcService.normalizeVehicleNumber(' dl 01 - ab 1234 '),
      ).toBe('DL01AB1234');
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
        publicKey: null,
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

    it('4b. Sandbox vehicle-rc omits x-cf-signature', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'VALID',
          verification_id: 'test_sb_1',
          reg_no: 'DL01AB1234',
        }),
      } as any);

      jest.spyOn(cashfreeConfigService, 'getConfig').mockReturnValueOnce({
        environment: 'sandbox',
        baseUrl: 'https://sandbox.cashfree.com/verification',
        clientId: 'sb-client-id',
        clientSecret: 'sb-client-secret',
        publicKey: null,
        redirectUrl: 'https://example.com/callback',
        timeoutMs: 5000,
      });

      await cashfreeRcService.verifyVehicleRc({
        verificationId: 'test_sb_1',
        vehicleNumber: 'DL01AB1234',
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://sandbox.cashfree.com/verification/vehicle-rc',
        expect.objectContaining({ method: 'POST' }),
      );
      const headers = (fetchSpy.mock.calls[0][1] as any).headers;
      expect(headers['x-cf-signature']).toBeUndefined();
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
        publicKey: null,
        redirectUrl: 'https://example.com',
        timeoutMs: 5000,
      });

      jest
        .spyOn(global, 'fetch')
        .mockRejectedValueOnce(new Error('Network drop'));

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
    it('14. Valid RC verification returns 200 and updates only that vehicle RC record', async () => {
      const login = await createAuthenticatedUser('Ramesh Kumar');
      const vehicle = await createTestVehicle(login.user.id, 'DL01AB1234');

      jest.spyOn(cashfreeRcService, 'verifyVehicleRc').mockResolvedValueOnce(
        matchingCashfreeRc('DL01AB1234', {
          verificationId: 'rc_valid_test_1',
          referenceId: 'ref_12345',
          chassis: '***1234',
          engine: '***5678',
          owner: 'Ramesh Kumar',
          seatCapacity: 5,
          isCommercial: false,
        }),
      );

      const res = await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ vehicleNumber: 'DL 01 AB 1234' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.vehicleId).toBe(vehicle.id);
      expect(res.body.verificationStatus).toBe('VERIFIED');
      expect(res.body.verification.status).toBe('VERIFIED');
      expect(res.body.verification.vehicleNumber).toBe('DL01AB1234');
      expect(res.body.verification.ownerMatchStatus).toBe(
        VehicleOwnerMatchStatus.MATCHED,
      );
      expect(res.body.checks.registrationNumber.status).toBe('MATCHED');
      expect(res.body.checks.vehicleName.status).toBe('MATCHED');
      expect(res.body.errors).toEqual([]);

      // Verify Vehicle table updated
      const updatedVehicle = await dataSource
        .getRepository(Vehicle)
        .findOneByOrFail({ id: vehicle.id });
      expect(updatedVehicle.documentType).toBe('RC');
      expect(updatedVehicle.documentReference).toBeDefined();

      const userVerif = await dataSource
        .getRepository(UserVerification)
        .findOne({
          where: {
            userId: login.user.id,
            verificationType: VerificationType.VEHICLE,
            isCurrent: true,
          },
        });
      expect(userVerif).toBeNull();

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
        .mockResolvedValueOnce(matchingCashfreeRc('HR26DK8888'));

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
        .mockResolvedValueOnce(matchingCashfreeRc('MH02CL5555'));

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
          failureCode: 'VEHICLE_RC_INVALID',
          failureReason: 'RC details not found in registry',
        })
        .mockResolvedValueOnce(matchingCashfreeRc('DL01REVERIF1'));

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

    it('21. Authorization: User A cannot verify User B vehicle (404)', async () => {
      const userA = await createAuthenticatedUser('User A');
      const userB = await createAuthenticatedUser('User B');
      const vehicleB = await createTestVehicle(userB.user.id, 'UP16CD1234');
      const verifySpy = jest.spyOn(cashfreeRcService, 'verifyVehicleRc');

      await request(app.getHttpServer())
        .post(`/vehicles/${vehicleB.id}/verify-rc`)
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ vehicleNumber: 'UP16CD1234' })
        .expect(404);

      expect(verifySpy).not.toHaveBeenCalled();
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
      jest.spyOn(cashfreeRcService, 'verifyVehicleRc').mockResolvedValueOnce(
        matchingCashfreeRc('KA01AB4321', {
          verificationId: 'rc_owner_diff',
          owner: 'Suresh Patel',
        }),
      );

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
      jest.spyOn(cashfreeRcService, 'verifyVehicleRc').mockResolvedValueOnce(
        matchingCashfreeRc('DL01PUBSH1', {
          verificationId: 'rc_publish_success',
        }),
      );

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

    it('26. Verifying vehicle A does not change vehicles B or C', async () => {
      const login = await createAuthenticatedUser();
      const vehicleA = await createTestVehicle(
        login.user.id,
        uniqueRegistration('UP16'),
      );
      const vehicleB = await createTestVehicle(
        login.user.id,
        uniqueRegistration('DL8C'),
        {
          isActive: false,
          make: 'Honda',
          model: 'City',
        },
      );
      const vehicleC = await createTestVehicle(
        login.user.id,
        uniqueRegistration('HR26'),
        {
          isActive: false,
          make: 'Maruti',
          model: 'Swift',
        },
      );

      const verifySpy = jest
        .spyOn(cashfreeRcService, 'verifyVehicleRc')
        .mockResolvedValueOnce(matchingCashfreeRc(vehicleA.registrationNumber));

      await request(app.getHttpServer())
        .post(`/vehicles/${vehicleA.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({})
        .expect(200);

      expect(verifySpy).toHaveBeenCalledTimes(1);
      expect(verifySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          vehicleNumber: vehicleA.registrationNumber,
        }),
      );

      const rcRepo = dataSource.getRepository(VehicleRcVerification);
      const aRecord = await rcRepo.findOne({
        where: { vehicleId: vehicleA.id },
        order: { createdAt: 'DESC' },
      });
      const bRecords = await rcRepo.find({ where: { vehicleId: vehicleB.id } });
      const cRecords = await rcRepo.find({ where: { vehicleId: vehicleC.id } });

      expect(aRecord?.status).toBe(VehicleRcVerificationStatus.VALID);
      expect(bRecords).toHaveLength(0);
      expect(cRecords).toHaveLength(0);

      const list = await request(app.getHttpServer())
        .get('/vehicles')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      const byId = new Map(
        list.body.map((row: { id: string }) => [row.id, row]),
      );
      expect(byId.get(vehicleA.id)).toMatchObject({
        rcVerificationStatus: PublicVehicleRcStatus.VERIFIED,
        registrationNumber: vehicleA.registrationNumber,
      });
      expect(byId.get(vehicleB.id)).toMatchObject({
        rcVerificationStatus: PublicVehicleRcStatus.NOT_VERIFIED,
      });
      expect(byId.get(vehicleC.id)).toMatchObject({
        rcVerificationStatus: PublicVehicleRcStatus.NOT_VERIFIED,
      });
    });

    it('27. Vehicle name/model mismatch returns field-level error', async () => {
      const login = await createAuthenticatedUser();
      const vehicle = await createTestVehicle(login.user.id, 'UP16NM9991');

      jest.spyOn(cashfreeRcService, 'verifyVehicleRc').mockResolvedValueOnce(
        matchingCashfreeRc('UP16NM9991', {
          model: 'Grand i10',
        }),
      );

      const res = await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({})
        .expect(422);

      expect(res.body.code).toBe('VEHICLE_DETAILS_MISMATCH');
      expect(res.body.checks.model.status).toBe('MISMATCHED');
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'VEHICLE_DETAILS_MISMATCH',
            field: 'model',
          }),
        ]),
      );

      const rcRecord = await dataSource
        .getRepository(VehicleRcVerification)
        .findOneByOrFail({ vehicleId: vehicle.id });
      expect(rcRecord.status).toBe(VehicleRcVerificationStatus.INVALID);
    });

    it('28. Colour mismatch is reported when the provider returns a colour', async () => {
      const login = await createAuthenticatedUser();
      const vehicle = await createTestVehicle(login.user.id, 'UP16CL9992');

      jest
        .spyOn(cashfreeRcService, 'verifyVehicleRc')
        .mockResolvedValueOnce(
          matchingCashfreeRc('UP16CL9992', { vehicleColor: 'Black' }),
        );

      const res = await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({})
        .expect(422);

      expect(res.body.checks.colour.status).toBe('MISMATCHED');
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'VEHICLE_DETAILS_MISMATCH',
            field: 'colour',
          }),
        ]),
      );
    });

    it('29. Expired insurance returns INSURANCE_EXPIRED', async () => {
      const login = await createAuthenticatedUser();
      const vehicle = await createTestVehicle(login.user.id, 'UP16IN9993');

      jest.spyOn(cashfreeRcService, 'verifyVehicleRc').mockResolvedValueOnce(
        matchingCashfreeRc('UP16IN9993', {
          vehicleInsuranceUpto: '2020-01-01',
        }),
      );

      const res = await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({})
        .expect(422);

      expect(res.body.code).toBe('INSURANCE_EXPIRED');
      expect(res.body.checks.insurance.status).toBe('MISMATCHED');
    });

    it('30. Invalid vehicle registration status returns VEHICLE_STATUS_INVALID', async () => {
      const login = await createAuthenticatedUser();
      const vehicle = await createTestVehicle(login.user.id, 'UP16ST9994');

      jest
        .spyOn(cashfreeRcService, 'verifyVehicleRc')
        .mockResolvedValueOnce(
          matchingCashfreeRc('UP16ST9994', { rcStatus: 'EXPIRED' }),
        );

      const res = await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({})
        .expect(422);

      expect(res.body.code).toBe('VEHICLE_STATUS_INVALID');
    });

    it('31. Missing provider fields fail safely without marking verified', async () => {
      const login = await createAuthenticatedUser();
      const vehicle = await createTestVehicle(login.user.id, 'UP16MS9995');

      jest.spyOn(cashfreeRcService, 'verifyVehicleRc').mockResolvedValueOnce({
        verificationId: 'rc_missing_fields',
        status: 'VALID',
        regNo: 'UP16MS9995',
      });

      const res = await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({})
        .expect(422);

      expect(res.body.checks.vehicleName.status).toBe('NOT_AVAILABLE');
      expect(res.body.checks.insurance.status).toBe('NOT_AVAILABLE');
      expect(
        res.body.verificationStatus ?? res.body.details?.verificationStatus,
      ).toBe('FAILED');

      const rcRecord = await dataSource
        .getRepository(VehicleRcVerification)
        .findOneByOrFail({ vehicleId: vehicle.id });
      expect(rcRecord.status).toBe(VehicleRcVerificationStatus.INVALID);
    });

    it('32. Provider timeout marks the attempt FAILED, not VERIFIED', async () => {
      const login = await createAuthenticatedUser();
      const vehicle = await createTestVehicle(login.user.id, 'UP16TO9996');

      jest
        .spyOn(cashfreeRcService, 'verifyVehicleRc')
        .mockRejectedValueOnce(
          new CashfreeApiError(
            'Failed to communicate with Cashfree Vehicle RC service',
          ),
        );

      await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({})
        .expect(502);

      const rcRecord = await dataSource
        .getRepository(VehicleRcVerification)
        .findOneByOrFail({ vehicleId: vehicle.id });
      expect(rcRecord.status).toBe(VehicleRcVerificationStatus.FAILED);
      expect(rcRecord.failureCode).toBe('RC_PROVIDER_UNAVAILABLE');
    });

    it('33. Duplicate in-flight verification does not start a second provider call', async () => {
      const login = await createAuthenticatedUser();
      const vehicle = await createTestVehicle(login.user.id, 'UP16DP9997');
      const rcRepo = dataSource.getRepository(VehicleRcVerification);
      await rcRepo.save(
        rcRepo.create({
          vehicleId: vehicle.id,
          userId: login.user.id,
          provider: 'CASHFREE',
          verificationId: `rc_pending_${Date.now()}`,
          requestedVehicleNumber: vehicle.registrationNumber,
          status: VehicleRcVerificationStatus.PENDING,
        }),
      );

      const verifySpy = jest.spyOn(cashfreeRcService, 'verifyVehicleRc');

      const res = await request(app.getHttpServer())
        .post(`/vehicles/${vehicle.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({})
        .expect(409);

      expect(res.body.code).toBe('VEHICLE_RC_IN_PROGRESS');
      expect(verifySpy).not.toHaveBeenCalled();
    });

    it('34. Two different vehicles can be verified independently', async () => {
      const login = await createAuthenticatedUser();
      const vehicleA = await createTestVehicle(
        login.user.id,
        uniqueRegistration('MH12'),
      );
      const vehicleB = await createTestVehicle(
        login.user.id,
        uniqueRegistration('KA03'),
        {
          isActive: false,
          make: 'Honda',
          model: 'City',
          color: 'White',
        },
      );

      const verifySpy = jest
        .spyOn(cashfreeRcService, 'verifyVehicleRc')
        .mockResolvedValueOnce(matchingCashfreeRc(vehicleA.registrationNumber))
        .mockResolvedValueOnce(
          matchingCashfreeRc(vehicleB.registrationNumber, {
            vehicleManufacturerName: 'Honda',
            model: 'City',
          }),
        );

      await request(app.getHttpServer())
        .post(`/vehicles/${vehicleA.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({})
        .expect(200);

      await request(app.getHttpServer())
        .post(`/vehicles/${vehicleB.id}/verify-rc`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({})
        .expect(200);

      expect(verifySpy).toHaveBeenCalledTimes(2);

      const rcRepo = dataSource.getRepository(VehicleRcVerification);
      const aRecord = await rcRepo.findOneOrFail({
        where: { vehicleId: vehicleA.id },
        order: { createdAt: 'DESC' },
      });
      const bRecord = await rcRepo.findOneOrFail({
        where: { vehicleId: vehicleB.id },
        order: { createdAt: 'DESC' },
      });
      expect(aRecord.status).toBe(VehicleRcVerificationStatus.VALID);
      expect(bRecord.status).toBe(VehicleRcVerificationStatus.VALID);
      expect(aRecord.id).not.toBe(bRecord.id);
      expect(aRecord.requestedVehicleNumber).toBe(vehicleA.registrationNumber);
      expect(bRecord.requestedVehicleNumber).toBe(vehicleB.registrationNumber);
    });
  });
});
