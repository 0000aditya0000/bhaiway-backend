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
import { UserVerification } from '../verification/entities/user-verification.entity';
import {
  VerificationStatus,
  VerificationType,
} from '../verification/enums/verification.enums';
import { VerificationModule } from '../verification/verification.module';
import { VerificationService } from '../verification/verification.service';
import {
  markVerificationVerified,
  rejectVerification,
} from '../verification/test/verification-test.helpers';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { VehicleType } from '../vehicles/enums/vehicle-type.enum';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { VehiclesService } from '../vehicles/vehicles.service';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';
import { Ride } from './entities/ride.entity';
import { RideStatus, RideType } from './enums/ride.enums';
import { RidesModule } from './rides.module';

describe('RidesController (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
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
        RidesModule,
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
    vehiclesService = moduleRef.get(VehiclesService);
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await dataSource.getRepository(Ride).delete({ driverId: ctx.userId });
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

  async function markVerified(userId: string, type: VerificationType) {
    await markVerificationVerified(
      verificationService,
      dataSource,
      userId,
      type,
    );
  }

  async function createVehicleForUser(userId: string) {
    return vehiclesService.create(userId, {
      vehicleType: VehicleType.CAR,
      make: 'Honda',
      model: 'City',
      variant: 'ZX',
      registrationNumber: `UP16${Date.now().toString().slice(-6)}${Math.floor(
        Math.random() * 10,
      )}`,
      registrationYear: 2024,
      color: 'White',
      seatingCapacity: 5,
    });
  }

  async function fullyEligibleDriver() {
    const login = await createAuthenticatedUser();
    const vehicle = await createVehicleForUser(login.user.id);
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
    await markVerified(login.user.id, VerificationType.VEHICLE);
    return { login, vehicle };
  }

  function ridePayload(vehicleId: string, overrides: Record<string, unknown> = {}) {
    return {
      rideType: RideType.REGULAR,
      vehicleId,
      source: 'Noida Sector 62',
      destination: 'Connaught Place',
      departureDate: '2026-08-20',
      departureTime: '09:00',
      totalSeats: 3,
      pricePerSeat: 250,
      maxTwoInBackSeat: true,
      noSmoking: true,
      noPets: true,
      luggageAllowed: true,
      notes: 'AC car',
      ...overrides,
    };
  }

  it('POST /rides requires JWT', async () => {
    await request(app.getHttpServer())
      .post('/rides')
      .send(ridePayload('00000000-0000-4000-8000-000000000001'))
      .expect(401);
  });

  it('unverified user cannot publish', async () => {
    const login = await createAuthenticatedUser();
    const vehicle = await createVehicleForUser(login.user.id);

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id))
      .expect(403);
  });

  it('user without verified DL cannot publish', async () => {
    const login = await createAuthenticatedUser();
    const vehicle = await createVehicleForUser(login.user.id);
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await rejectVerification(
      verificationService,
      dataSource,
      login.user.id,
      VerificationType.DRIVING_LICENSE,
    );

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id))
      .expect(403);
  });

  it('user without verified vehicle cannot publish', async () => {
    const login = await createAuthenticatedUser();
    const vehicle = await createVehicleForUser(login.user.id);
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await rejectVerification(
      verificationService,
      dataSource,
      login.user.id,
      VerificationType.VEHICLE,
    );

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id))
      .expect(403);
  });

  it('user cannot use another user vehicle', async () => {
    const driver = await fullyEligibleDriver();
    const other = await fullyEligibleDriver();

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send(ridePayload(other.vehicle.id))
      .expect(403);
  });

  it('inactive vehicle rejected', async () => {
    const { login } = await fullyEligibleDriver();
    const second = await createVehicleForUser(login.user.id);
    // first remains active; second is inactive by default after first exists
    expect(second.isActive).toBe(false);

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(second.id))
      .expect(403);
  });

  it('deleted vehicle rejected', async () => {
    const { login, vehicle } = await fullyEligibleDriver();
    await vehiclesService.remove(login.user.id, vehicle.id);

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id))
      .expect(403);
  });

  it('unverified vehicle rejected', async () => {
    const login = await createAuthenticatedUser();
    const vehicle = await createVehicleForUser(login.user.id);
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await rejectVerification(
      verificationService,
      dataSource,
      login.user.id,
      VerificationType.VEHICLE,
    );

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id))
      .expect(403);
  });

  it('stub identity verification bootstrap allows publishing without separate DL/vehicle submit', async () => {
    const login = await createAuthenticatedUser();
    const vehicle = await createVehicleForUser(login.user.id);

    await request(app.getHttpServer())
      .post('/verification/identity')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ documentType: 'IDENTITY_SCAN' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id))
      .expect(201);
  });

  it('successful ride creation', async () => {
    const { login, vehicle } = await fullyEligibleDriver();

    const response = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id))
      .expect(201);

    expect(response.body).toMatchObject({
      driverId: login.user.id,
      vehicleId: vehicle.id,
      rideType: RideType.REGULAR,
      status: RideStatus.PUBLISHED,
      source: 'Noida Sector 62',
      destination: 'Connaught Place',
      departureDate: '2026-08-20',
      totalSeats: 3,
      availableSeats: 3,
      pricePerSeat: '250',
      maxTwoInBackSeat: true,
      noSmoking: true,
      noPets: true,
      luggageAllowed: true,
      notes: 'AC car',
    });
    expect(response.body.departureTime).toMatch(/^09:00/);
  });

  it('driverId cannot be supplied', async () => {
    const { login, vehicle } = await fullyEligibleDriver();
    const other = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id, { driverId: other.user.id }))
      .expect(400);
  });

  it('status cannot be supplied', async () => {
    const { login, vehicle } = await fullyEligibleDriver();

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id, { status: RideStatus.CANCELLED }))
      .expect(400);
  });

  it('availableSeats cannot be supplied', async () => {
    const { login, vehicle } = await fullyEligibleDriver();

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id, { availableSeats: 1 }))
      .expect(400);
  });

  it('availableSeats initially equals totalSeats', async () => {
    const { login, vehicle } = await fullyEligibleDriver();

    const response = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id, { totalSeats: 4 }))
      .expect(201);

    expect(response.body.availableSeats).toBe(4);
    expect(response.body.totalSeats).toBe(4);
  });

  it('invalid date rejected', async () => {
    const { login, vehicle } = await fullyEligibleDriver();

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id, { departureDate: 'not-a-date' }))
      .expect(400);
  });

  it('invalid time rejected', async () => {
    const { login, vehicle } = await fullyEligibleDriver();

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id, { departureTime: '25:99' }))
      .expect(400);
  });

  it('invalid seat count rejected', async () => {
    const { login, vehicle } = await fullyEligibleDriver();

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id, { totalSeats: 0 }))
      .expect(400);
  });

  it('invalid vehicle UUID rejected', async () => {
    const { login } = await fullyEligibleDriver();

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload('not-a-uuid'))
      .expect(400);
  });

  it('GET /rides/my returns only driver rides', async () => {
    const driverA = await fullyEligibleDriver();
    const driverB = await fullyEligibleDriver();

    const created = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driverA.login.accessToken}`)
      .send(ridePayload(driverA.vehicle.id))
      .expect(201);

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driverB.login.accessToken}`)
      .send(ridePayload(driverB.vehicle.id))
      .expect(201);

    const mine = await request(app.getHttpServer())
      .get('/rides/my')
      .set('Authorization', `Bearer ${driverA.login.accessToken}`)
      .expect(200);

    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].id).toBe(created.body.id);
  });

  it('GET /rides/:id is owner-only (IDOR-safe)', async () => {
    const driverA = await fullyEligibleDriver();
    const driverB = await fullyEligibleDriver();

    const created = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driverA.login.accessToken}`)
      .send(ridePayload(driverA.vehicle.id))
      .expect(201);

    await request(app.getHttpServer())
      .get(`/rides/${created.body.id}`)
      .set('Authorization', `Bearer ${driverA.login.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/rides/${created.body.id}`)
      .set('Authorization', `Bearer ${driverB.login.accessToken}`)
      .expect(404);
  });

  it('driver can update own ride', async () => {
    const { login, vehicle } = await fullyEligibleDriver();

    const created = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id))
      .expect(201);

    const updated = await request(app.getHttpServer())
      .patch(`/rides/${created.body.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ notes: 'Updated notes', pricePerSeat: 300 })
      .expect(200);

    expect(updated.body.notes).toBe('Updated notes');
    expect(updated.body.pricePerSeat).toBe('300');
  });

  it('driver cannot update another user ride', async () => {
    const driverA = await fullyEligibleDriver();
    const driverB = await fullyEligibleDriver();

    const created = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driverA.login.accessToken}`)
      .send(ridePayload(driverA.vehicle.id))
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/rides/${created.body.id}`)
      .set('Authorization', `Bearer ${driverB.login.accessToken}`)
      .send({ notes: 'hack' })
      .expect(404);
  });

  it('cannot modify driverId through PATCH', async () => {
    const { login, vehicle } = await fullyEligibleDriver();
    const other = await createAuthenticatedUser();

    const created = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id))
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/rides/${created.body.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ driverId: other.user.id })
      .expect(400);

    const row = await dataSource.getRepository(Ride).findOneByOrFail({
      id: created.body.id,
    });
    expect(row.driverId).toBe(login.user.id);
  });

  it('cannot modify status through PATCH', async () => {
    const { login, vehicle } = await fullyEligibleDriver();

    const created = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id))
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/rides/${created.body.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ status: RideStatus.CANCELLED })
      .expect(400);

    const row = await dataSource.getRepository(Ride).findOneByOrFail({
      id: created.body.id,
    });
    expect(row.status).toBe(RideStatus.PUBLISHED);
  });

  it('vehicle change re-validates ownership/verification', async () => {
    const { login, vehicle } = await fullyEligibleDriver();
    const other = await fullyEligibleDriver();

    const created = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(ridePayload(vehicle.id))
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/rides/${created.body.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ vehicleId: other.vehicle.id })
      .expect(403);

    const second = await createVehicleForUser(login.user.id);
    await vehiclesService.setActiveVehicle(login.user.id, second.id);

    await request(app.getHttpServer())
      .patch(`/rides/${created.body.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ vehicleId: second.id })
      .expect(200);

    const row = await dataSource.getRepository(Ride).findOneByOrFail({
      id: created.body.id,
    });
    expect(row.vehicleId).toBe(second.id);
  });
});
