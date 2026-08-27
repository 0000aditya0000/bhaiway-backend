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
import { BookingsModule } from '../bookings/bookings.module';
import { BookingPaymentMethod } from '../bookings/enums/booking.enums';
import { SettingsModule } from '../settings/settings.module';
import { UserProfile } from '../users/entities/user-profile.entity';
import { UserVerification } from '../verification/entities/user-verification.entity';
import { VerificationType } from '../verification/enums/verification.enums';
import { VerificationModule } from '../verification/verification.module';
import { VerificationService } from '../verification/verification.service';
import { markVerificationVerified } from '../verification/test/verification-test.helpers';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { VehicleType } from '../vehicles/enums/vehicle-type.enum';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { VehiclesService } from '../vehicles/vehicles.service';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { Booking } from '../bookings/entities/booking.entity';
import { Ride } from './entities/ride.entity';
import { RideStatus, RideType } from './enums/ride.enums';
import { RidesModule } from './rides.module';
import {
  ASSURED_TEST_ROUTE,
  withAssuredPublishHeaders,
} from './test/assured-ride-test.helpers';

describe('Assured passenger search visibility', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  const tracked: TestWalletContext[] = [];

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.DATABASE_URL);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env.test' }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: process.env.DATABASE_URL,
          autoLoadEntities: true,
          synchronize: false,
          logging: false,
        }),
        AuthModule,
        WalletModule,
        SettingsModule,
        VerificationModule,
        VehiclesModule,
        RidesModule,
        BookingsModule,
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
    walletService = moduleRef.get(WalletService);
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await dataSource.getRepository(Booking).delete({
          passengerId: ctx.userId,
        });
        const rides = await dataSource.getRepository(Ride).find({
          where: { driverId: ctx.userId },
        });
        for (const ride of rides) {
          await dataSource.getRepository(Booking).delete({ rideId: ride.id });
        }
        await dataSource.getRepository(Ride).delete({ driverId: ctx.userId });
        await dataSource.getRepository(Vehicle).delete({ userId: ctx.userId });
        await dataSource.getRepository(UserVerification).delete({
          userId: ctx.userId,
        });
        await dataSource.getRepository(UserProfile).delete({
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

  async function createAuthenticatedUser(displayName = 'Visibility User') {
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

    await dataSource.getRepository(UserProfile).save(
      dataSource.getRepository(UserProfile).create({
        userId: login.user.id,
        firstName: 'Visibility',
        lastName: 'User',
        displayName,
        gender: null,
        dateOfBirth: null,
        profilePhoto: null,
      }),
    );

    return { login, wallet };
  }

  async function publishableDriver() {
    const { login, wallet } = await createAuthenticatedUser('Visibility Driver');
    const vehicle = await vehiclesService.create(login.user.id, {
      vehicleType: VehicleType.CAR,
      make: 'Toyota',
      model: 'Innova',
      registrationNumber: `DL01${Date.now().toString().slice(-6)}`,
      seatingCapacity: 6,
    });
    await markVerificationVerified(
      verificationService,
      dataSource,
      login.user.id,
      VerificationType.IDENTITY,
    );
    await markVerificationVerified(
      verificationService,
      dataSource,
      login.user.id,
      VerificationType.DRIVING_LICENSE,
    );
    await markVerificationVerified(
      verificationService,
      dataSource,
      login.user.id,
      VerificationType.VEHICLE,
    );
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: 5000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('visibility-driver'),
    });
    return { login, vehicle, wallet };
  }

  async function verifiedPassenger(credit = 5000n) {
    const { login, wallet } = await createAuthenticatedUser('Passenger');
    await markVerificationVerified(
      verificationService,
      dataSource,
      login.user.id,
      VerificationType.IDENTITY,
    );
    if (credit > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: credit,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('visibility-pass'),
      });
    }
    return { login, wallet };
  }

  function assuredPayload(
    vehicleId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      rideType: RideType.ASSURED,
      vehicleId,
      source: 'Noida Visibility Hub',
      destination: 'Delhi Visibility Dest',
      departureDate: '2026-12-01',
      departureTime: '09:00',
      totalSeats: 4,
      pricePerSeat: 300,
      ...ASSURED_TEST_ROUTE,
      ...overrides,
    };
  }

  async function publishAssured(
    accessToken: string,
    vehicleId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(accessToken))
      .send(assuredPayload(vehicleId, overrides))
      .expect(201);
  }

  async function searchAssured(accessToken: string) {
    return request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${accessToken}`)
      .query({
        source: 'Noida Visibility Hub',
        destination: 'Delhi Visibility Dest',
        date: '2026-12-01',
        rideType: RideType.ASSURED,
      })
      .expect(200);
  }

  it('A: ASSURANCE_ACTIVE with seats appears in passenger search', async () => {
    const passenger = await verifiedPassenger();
    const { login, vehicle } = await publishableDriver();

    const created = await publishAssured(login.accessToken, vehicle.id);
    expect(created.body.status).toBe(RideStatus.ASSURANCE_ACTIVE);

    const res = await searchAssured(passenger.login.accessToken);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(created.body.id);
    expect(res.body.items[0].status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(res.body.items[0].rideType).toBe(RideType.ASSURED);
  });

  it('B: ASSURANCE_PENDING does not appear in passenger search', async () => {
    const passenger = await verifiedPassenger();
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureTime: '09:00',
    });
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '09:30',
    });
    expect(pending.body.status).toBe(RideStatus.ASSURANCE_PENDING);

    const res = await searchAssured(passenger.login.accessToken);
    expect(
      res.body.items.map((item: { id: string }) => item.id),
    ).not.toContain(pending.body.id);
    expect(
      res.body.items.every(
        (item: { status: string }) =>
          item.status === RideStatus.ASSURANCE_ACTIVE,
      ),
    ).toBe(true);
  });

  it('C: ASSURANCE_ACTIVE with 0 seats does not appear in search', async () => {
    const passenger = await verifiedPassenger();
    const { login, vehicle } = await publishableDriver();

    const created = await publishAssured(login.accessToken, vehicle.id);
    await dataSource.getRepository(Ride).update(created.body.id, {
      availableSeats: 0,
    });

    const res = await searchAssured(passenger.login.accessToken);
    expect(res.body.items).toHaveLength(0);
  });

  it('D: PUBLISHED is not required for Assured passenger visibility', async () => {
    const passenger = await verifiedPassenger();
    const { login, vehicle } = await publishableDriver();

    const created = await publishAssured(login.accessToken, vehicle.id);
    expect(created.body.status).toBe(RideStatus.ASSURANCE_ACTIVE);

    const res = await searchAssured(passenger.login.accessToken);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].status).not.toBe(RideStatus.PUBLISHED);
    expect(res.body.items[0].status).toBe(RideStatus.ASSURANCE_ACTIVE);
  });

  it('E: Regular PUBLISHED ride search behavior unchanged', async () => {
    const passenger = await verifiedPassenger(0n);
    const { login, vehicle } = await publishableDriver();

    const regular = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        rideType: RideType.REGULAR,
        vehicleId: vehicle.id,
        source: 'Noida Visibility Hub',
        destination: 'Delhi Visibility Dest',
        departureDate: '2026-12-01',
        departureTime: '08:00',
        totalSeats: 3,
        pricePerSeat: 200,
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .query({
        source: 'Noida Visibility Hub',
        destination: 'Delhi Visibility Dest',
        date: '2026-12-01',
        rideType: RideType.REGULAR,
      })
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(regular.body.id);
    expect(res.body.items[0].status).toBe(RideStatus.PUBLISHED);
  });

  it('G: GET /rides/public/:id returns Assured ACTIVE details with deposit snapshot', async () => {
    const passenger = await verifiedPassenger(0n);
    const { login, vehicle } = await publishableDriver();
    // Default payload: totalSeats=4, pricePerSeat=300 → 4×300×5% = 60
    const created = await publishAssured(login.accessToken, vehicle.id);

    const detail = await request(app.getHttpServer())
      .get(`/rides/public/${created.body.id}`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    expect(detail.body.id).toBe(created.body.id);
    expect(detail.body.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(detail.body.assuredDepositPercentage).toBe(5);
    expect(detail.body.assuredDepositAmount).toBe('60');
  });

  it('G2: public Assured detail returns ₹5 deposit for ₹100 fare (1 seat, 5%)', async () => {
    const passenger = await verifiedPassenger(0n);
    const { login, vehicle } = await publishableDriver();
    const created = await publishAssured(login.accessToken, vehicle.id, {
      totalSeats: 1,
      pricePerSeat: 100,
      departureTime: '10:00',
    });

    const detail = await request(app.getHttpServer())
      .get(`/rides/public/${created.body.id}`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    expect(detail.body.assuredDepositPercentage).toBe(5);
    expect(detail.body.assuredDepositAmount).toBe('5');
    expect(detail.body.pricePerSeat).toBe('100');
  });

  it('G3: public Assured detail returns ₹105 deposit for ₹700 × 3 seats at 5%', async () => {
    const passenger = await verifiedPassenger(0n);
    const { login, vehicle } = await publishableDriver();
    const created = await publishAssured(login.accessToken, vehicle.id, {
      totalSeats: 3,
      pricePerSeat: 700,
      departureTime: '11:00',
    });

    const detail = await request(app.getHttpServer())
      .get(`/rides/public/${created.body.id}`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    expect(detail.body.assuredDepositPercentage).toBe(5);
    expect(detail.body.assuredDepositAmount).toBe('105');
  });

  it('G4: Regular public detail does not expose Assured deposit amounts', async () => {
    const passenger = await verifiedPassenger(0n);
    const { login, vehicle } = await publishableDriver();

    const regular = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        rideType: RideType.REGULAR,
        vehicleId: vehicle.id,
        source: 'Noida Visibility Hub',
        destination: 'Delhi Visibility Dest',
        departureDate: '2026-12-01',
        departureTime: '07:30',
        totalSeats: 3,
        pricePerSeat: 200,
      })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/rides/public/${regular.body.id}`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    expect(detail.body.rideType).toBe(RideType.REGULAR);
    expect(detail.body.assuredDepositAmount).toBeNull();
    expect(detail.body.assuredDepositPercentage).toBeNull();
  });

  it('H: GET /rides/public/:id for Assured PENDING returns 404', async () => {
    const passenger = await verifiedPassenger(0n);
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureTime: '09:00',
    });
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '09:20',
    });
    expect(pending.body.status).toBe(RideStatus.ASSURANCE_PENDING);

    await request(app.getHttpServer())
      .get(`/rides/public/${pending.body.id}`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(404);
  });

  it('I: Assured ACTIVE booking with ASSURED_DEPOSIT remains valid', async () => {
    const passenger = await verifiedPassenger();
    const { login, vehicle } = await publishableDriver();
    const created = await publishAssured(login.accessToken, vehicle.id);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('visibility-book-active'))
      .send({
        rideId: created.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      })
      .expect(201);
  });

  it('J: Assured PENDING booking remains rejected', async () => {
    const passenger = await verifiedPassenger();
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureTime: '09:00',
    });
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '09:40',
    });
    expect(pending.body.status).toBe(RideStatus.ASSURANCE_PENDING);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('visibility-book-pending'))
      .send({
        rideId: pending.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      })
      .expect(400);
  });

  it('K: different windows → both ACTIVE and both passenger-visible', async () => {
    const passenger = await verifiedPassenger(0n);
    const { login, vehicle } = await publishableDriver();

    const morning = await publishAssured(login.accessToken, vehicle.id, {
      departureTime: '20:00',
    });
    const evening = await publishAssured(login.accessToken, vehicle.id, {
      departureTime: '21:00',
    });

    expect(morning.body.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(evening.body.status).toBe(RideStatus.ASSURANCE_ACTIVE);

    const res = await searchAssured(passenger.login.accessToken);
    const ids = res.body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(morning.body.id);
    expect(ids).toContain(evening.body.id);
    expect(res.body.items).toHaveLength(2);
  });

  it('L: same window → only ACTIVE visible; PENDING hidden', async () => {
    const passenger = await verifiedPassenger(0n);
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    const active = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureTime: '09:10',
    });
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '09:40',
    });

    expect(active.body.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(pending.body.status).toBe(RideStatus.ASSURANCE_PENDING);

    const res = await searchAssured(passenger.login.accessToken);
    const ids = res.body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(active.body.id);
    expect(ids).not.toContain(pending.body.id);
    expect(res.body.items).toHaveLength(1);
  });
});
