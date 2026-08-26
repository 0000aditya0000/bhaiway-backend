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
import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingPaymentMethod,
  BookingPickupStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { SettingsModule } from '../settings/settings.module';
import { TrackingModule } from '../tracking/tracking.module';
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
import {
  WalletHold,
  WalletHoldStatus,
} from '../wallet/entities/wallet-hold.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletService } from '../wallet/wallet.service';
import { Ride } from './entities/ride.entity';
import { RideStatus, RideType } from './enums/ride.enums';
import { RidesModule } from './rides.module';
import { ASSURED_TEST_ROUTE } from './test/assured-ride-test.helpers';
import { startRideAndVerifyAllPickups } from './test/ride-trip-test.helpers';

function pickupOtpPepper(): string {
  const secret = process.env.JWT_ACCESS_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new Error('JWT_ACCESS_SECRET is required for pickup OTP tests');
  }
  return secret;
}

describe('Assured ride trip lifecycle (integration)', () => {
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
        SettingsModule,
        VerificationModule,
        VehiclesModule,
        RidesModule,
        BookingsModule,
        TrackingModule,
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
        const rides = await dataSource.getRepository(Ride).find({
          where: { driverId: ctx.userId },
        });
        for (const ride of rides) {
          await dataSource.getRepository(Booking).delete({ rideId: ride.id });
        }
        await dataSource.getRepository(Booking).delete({
          passengerId: ctx.userId,
        });
        await dataSource.getRepository(Ride).delete({ driverId: ctx.userId });
        await dataSource.getRepository(Vehicle).delete({ userId: ctx.userId });
        await dataSource.getRepository(UserProfile).delete({
          userId: ctx.userId,
        });
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
    return { login, wallet };
  }

  async function markVerified(userId: string, type: VerificationType) {
    await markVerificationVerified(
      verificationService,
      dataSource,
      userId,
      type,
    );
  }

  async function fundedDriver(credit = 10000n) {
    const { login, wallet } = await createAuthenticatedUser();
    const vehicle = await vehiclesService.create(login.user.id, {
      vehicleType: VehicleType.CAR,
      make: 'Honda',
      model: 'City',
      variant: 'ZX',
      registrationNumber: `UP32${Date.now().toString().slice(-6)}${Math.floor(
        Math.random() * 10,
      )}`,
      registrationYear: 2024,
      color: 'Black',
      seatingCapacity: 5,
    });
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
    await markVerified(login.user.id, VerificationType.VEHICLE);
    if (credit > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: credit,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('assured-trip-driver'),
      });
    }
    return { login, wallet, vehicle };
  }

  async function fundedPassenger(credit = 2000n) {
    const { login, wallet } = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);
    if (credit > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: credit,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('assured-trip-pass'),
      });
    }
    return { login, wallet };
  }

  async function publishAssured(driver: Awaited<ReturnType<typeof fundedDriver>>) {
    const rideResponse = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        vehicleId: driver.vehicle.id,
        source: 'Assured Trip Source',
        destination: 'Assured Trip Dest',
        departureDate: '2026-12-10',
        departureTime: '09:00',
        totalSeats: 4,
        pricePerSeat: 500,
        ...ASSURED_TEST_ROUTE,
      })
      .expect(201);
    return rideResponse.body as { id: string };
  }

  async function bookAssured(
    passenger: Awaited<ReturnType<typeof fundedPassenger>>,
    rideId: string,
    seats = 1,
  ) {
    return request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('assured-trip-book'))
      .send({
        rideId,
        seats,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      })
      .expect(201);
  }

  it('driver can start ASSURANCE_ACTIVE Assured ride → IN_PROGRESS', async () => {
    const driver = await fundedDriver();
    const ride = await publishAssured(driver);

    const started = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    expect(started.body.status).toBe(RideStatus.IN_PROGRESS);
    expect(started.body.rideType).toBe(RideType.ASSURED);

    const row = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(row.status).toBe(RideStatus.IN_PROGRESS);

    const driverHold = await dataSource
      .getRepository(WalletHold)
      .findOneByOrFail({ id: row.driverDepositHoldId! });
    expect(driverHold.status).toBe(WalletHoldStatus.ACTIVE);
  });

  it('Assured booking gets pickup OTP after start and verify-pickup works', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const ride = await publishAssured(driver);
    const booking = await bookAssured(passenger, ride.id);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const mine = await request(app.getHttpServer())
      .get('/bookings/my')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    expect(mine.body[0].pickupOtp).toMatch(/^\d{4}$/);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ otp: mine.body[0].pickupOtp })
      .expect(200);

    const row = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(row.pickupStatus).toBe(BookingPickupStatus.PICKED_UP);
  });

  it('ASSURANCE_ACTIVE Assured ride cannot complete without start', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const ride = await publishAssured(driver);
    await bookAssured(passenger, ride.id);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(409);
  });

  it('Assured full trip: start → pickup → complete releases deposits', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(2000n);
    const ride = await publishAssured(driver);
    await bookAssured(passenger, ride.id);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    const completed = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    expect(completed.body.status).toBe(RideStatus.COMPLETED);
    expect(completed.body.releasedDeposits?.driver).toBe('100');
    expect(completed.body.releasedDeposits?.riders).toBe('25');
  });

  it('Assured IN_PROGRESS ride supports REST tracking like Regular', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const ride = await publishAssured(driver);
    await bookAssured(passenger, ride.id);

    await request(app.getHttpServer())
      .post(`/tracking/rides/${ride.id}/location`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ latitude: 28.6139, longitude: 77.209 })
      .expect(409);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const posted = await request(app.getHttpServer())
      .post(`/tracking/rides/${ride.id}/location`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        latitude: 28.6139,
        longitude: 77.209,
        timestamp: '2026-08-22T18:30:00.000Z',
      })
      .expect(200);

    expect(posted.body.rideStatus).toBe(RideStatus.IN_PROGRESS);

    const passengerView = await request(app.getHttpServer())
      .get(`/tracking/rides/${ride.id}`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    expect(passengerView.body.driverCoordinate).toMatchObject({
      latitude: 28.6139,
      longitude: 77.209,
    });
  });
});
