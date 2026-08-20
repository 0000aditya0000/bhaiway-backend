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
import { UserVerification } from '../verification/entities/user-verification.entity';
import {
  VerificationStatus,
  VerificationType,
} from '../verification/enums/verification.enums';
import { VerificationModule } from '../verification/verification.module';
import { VerificationService } from '../verification/verification.service';
import { markVerificationVerified } from '../verification/test/verification-test.helpers';
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

describe('VehiclesController (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
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
    verificationService = moduleRef.get(VerificationService);
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await dataSource.getRepository(Vehicle).delete({ userId: ctx.userId });
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

  function uniqueRegistration(prefix = 'UP16') {
    const suffix = `${Date.now().toString().slice(-4)}${Math.floor(
      Math.random() * 100,
    )
      .toString()
      .padStart(2, '0')}`;
    return `${prefix}AB${suffix}`;
  }

  async function createVehiclePayload(
    overrides: Record<string, unknown> = {},
  ) {
    return {
      vehicleType: VehicleType.CAR,
      make: 'Honda',
      model: 'City',
      variant: 'ZX',
      registrationNumber: uniqueRegistration(),
      registrationYear: 2024,
      color: 'White',
      seatingCapacity: 5,
      documentUrl: 'https://cdn.example.com/rc.pdf',
      documentType: 'RC',
      documentReference: 'rc-obj-1',
      ...overrides,
    };
  }

  async function markVerified(userId: string, type: VerificationType) {
    await markVerificationVerified(
      verificationService,
      dataSource,
      userId,
      type,
    );
  }

  it('POST /vehicles requires JWT', async () => {
    await request(app.getHttpServer())
      .post('/vehicles')
      .send(await createVehiclePayload())
      .expect(401);
  });

  it('creates a vehicle', async () => {
    const login = await createAuthenticatedUser();
    const payload = await createVehiclePayload();

    const response = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(payload)
      .expect(201);

    expect(response.body).toMatchObject({
      vehicleType: VehicleType.CAR,
      make: 'Honda',
      model: 'City',
      variant: 'ZX',
      registrationNumber: payload.registrationNumber,
      registrationYear: 2024,
      color: 'White',
      seatingCapacity: 5,
      isActive: true,
    });
    expect(response.body.id).toBeTruthy();
    expect(response.body.documentUrl).toBeUndefined();
    expect(response.body.userId).toBeUndefined();
  });

  it('vehicle belongs to authenticated user', async () => {
    const login = await createAuthenticatedUser();
    const payload = await createVehiclePayload();

    const created = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(payload)
      .expect(201);

    const row = await dataSource.getRepository(Vehicle).findOneByOrFail({
      id: created.body.id,
    });
    expect(row.userId).toBe(login.user.id);
  });

  it('userId cannot be supplied/overridden', async () => {
    const userA = await createAuthenticatedUser();
    const userB = await createAuthenticatedUser();
    const payload = await createVehiclePayload({
      userId: userB.user.id,
    });

    await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send(payload)
      .expect(400);
  });

  it('normalizes registration number', async () => {
    const login = await createAuthenticatedUser();
    const raw = ` up16ab ${Date.now().toString().slice(-4)} `;

    const response = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload({ registrationNumber: raw }))
      .expect(201);

    expect(response.body.registrationNumber).toBe(
      raw.trim().toUpperCase().replace(/\s+/g, ''),
    );
  });

  it('rejects duplicate registration for the same user', async () => {
    const login = await createAuthenticatedUser();
    const registrationNumber = uniqueRegistration();

    await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload({ registrationNumber }))
      .expect(201);

    await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(
        await createVehiclePayload({
          registrationNumber: registrationNumber.toLowerCase(),
          make: 'Toyota',
        }),
      )
      .expect(409);
  });

  it('GET /vehicles returns only current user vehicles', async () => {
    const userA = await createAuthenticatedUser();
    const userB = await createAuthenticatedUser();

    const createdA = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    const list = await request(app.getHttpServer())
      .get('/vehicles')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);

    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(createdA.body.id);
  });

  it('GET /vehicles/:id returns own vehicle', async () => {
    const login = await createAuthenticatedUser();
    const created = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/vehicles/${created.body.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(response.body.id).toBe(created.body.id);
  });

  it('GET another user vehicle → 404', async () => {
    const userA = await createAuthenticatedUser();
    const userB = await createAuthenticatedUser();

    const created = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    await request(app.getHttpServer())
      .get(`/vehicles/${created.body.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(404);
  });

  it('updates own vehicle', async () => {
    const login = await createAuthenticatedUser();
    const created = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    const updated = await request(app.getHttpServer())
      .patch(`/vehicles/${created.body.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ color: 'Black' })
      .expect(200);

    expect(updated.body.color).toBe('Black');
    expect(updated.body.make).toBe('Honda');
  });

  it('cannot update another user vehicle', async () => {
    const userA = await createAuthenticatedUser();
    const userB = await createAuthenticatedUser();

    const created = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/vehicles/${created.body.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ color: 'Red' })
      .expect(404);
  });

  it('cannot modify verification fields via vehicle API', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(
        await createVehiclePayload({
          isVerified: true,
          verificationStatus: 'VERIFIED',
          verifiedAt: new Date().toISOString(),
          provider: 'evil',
          providerReference: 'x',
        }),
      )
      .expect(400);

    const created = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/vehicles/${created.body.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ isVerified: true, status: 'VERIFIED' })
      .expect(400);
  });

  it('activates a vehicle', async () => {
    const login = await createAuthenticatedUser();
    const first = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    expect(first.body.isActive).toBe(true);

    const second = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    expect(second.body.isActive).toBe(false);

    const activated = await request(app.getHttpServer())
      .post(`/vehicles/${second.body.id}/activate`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(201);

    expect(activated.body.id).toBe(second.body.id);
    expect(activated.body.isActive).toBe(true);
  });

  it('activating one vehicle deactivates previous active vehicle', async () => {
    const login = await createAuthenticatedUser();

    const first = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    await request(app.getHttpServer())
      .post(`/vehicles/${second.body.id}/activate`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(201);

    const firstRow = await dataSource.getRepository(Vehicle).findOneByOrFail({
      id: first.body.id,
    });
    const secondRow = await dataSource.getRepository(Vehicle).findOneByOrFail({
      id: second.body.id,
    });

    expect(firstRow.isActive).toBe(false);
    expect(secondRow.isActive).toBe(true);
  });

  it('cannot activate another user vehicle', async () => {
    const userA = await createAuthenticatedUser();
    const userB = await createAuthenticatedUser();

    const created = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    await request(app.getHttpServer())
      .post(`/vehicles/${created.body.id}/activate`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(404);
  });

  it('soft-deletes a vehicle safely', async () => {
    const login = await createAuthenticatedUser();
    const created = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/vehicles/${created.body.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    const list = await request(app.getHttpServer())
      .get('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(list.body).toHaveLength(0);

    const row = await dataSource.getRepository(Vehicle).findOne({
      where: { id: created.body.id },
      withDeleted: true,
    });
    expect(row).toBeTruthy();
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.isActive).toBe(false);
  });

  it('stub bootstrap on vehicle create associates vehicle verification with the vehicle', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN' })
      .expect(201);

    const created = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    const record = await dataSource.getRepository(UserVerification).findOneBy({
      userId: login.user.id,
      verificationType: VerificationType.VEHICLE,
      isCurrent: true,
    });

    expect(record).toBeTruthy();
    expect(record!.status).toBe(VerificationStatus.VERIFIED);
    expect(record!.documentReference).toBe(created.body.id);
  });

  it('vehicle verification remains controlled by UserVerification', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN' })
      .expect(201);

    const created = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    expect(created.body.isVerified).toBeUndefined();
    expect(created.body.verificationStatus).toBeUndefined();

    const me = await verificationService.getMyVerifications(login.user.id);
    expect(me.vehicle.status).toBe(VerificationStatus.VERIFIED);

    await request(app.getHttpServer())
      .patch(`/vehicles/${created.body.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ registrationNumber: uniqueRegistration() })
      .expect(200);

    const after = await verificationService.getMyVerifications(login.user.id);
    expect(after.vehicle.status).toBe(VerificationStatus.REJECTED);
  });

  it('canPublishRide requires verified vehicle and active owned vehicle', async () => {
    const login = await createAuthenticatedUser();
    const created = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    let result = await verificationService.canPublishRide(
      login.user.id,
      created.body.id,
    );
    expect(result.allowed).toBe(false);
    expect(result.vehicleEligible).toBe(true);
    expect(result.missing).toEqual(
      expect.arrayContaining([
        VerificationType.IDENTITY,
        VerificationType.DRIVING_LICENSE,
        VerificationType.VEHICLE,
      ]),
    );

    await markVerified(login.user.id, VerificationType.IDENTITY);
    await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
    await markVerified(login.user.id, VerificationType.VEHICLE);

    result = await verificationService.canPublishRide(
      login.user.id,
      created.body.id,
    );
    expect(result.allowed).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.vehicleEligible).toBe(true);

    const second = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    result = await verificationService.canPublishRide(
      login.user.id,
      second.body.id,
    );
    expect(result.allowed).toBe(false);
    expect(result.vehicleEligible).toBe(false);
  });

  it('cannot set isActive via PATCH', async () => {
    const login = await createAuthenticatedUser();
    const first = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/vehicles')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(await createVehiclePayload())
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/vehicles/${second.body.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ isActive: true })
      .expect(400);

    const firstRow = await dataSource.getRepository(Vehicle).findOneByOrFail({
      id: first.body.id,
      deletedAt: IsNull(),
    });
    expect(firstRow.isActive).toBe(true);
  });
});
