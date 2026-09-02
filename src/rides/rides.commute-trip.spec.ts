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
import { RatingTask } from '../ratings/entities/rating-task.entity';
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
import { decryptPickupOtp } from '../bookings/pickup-otp.util';
import { startRideAndVerifyAllPickups } from './test/ride-trip-test.helpers';

function pickupOtpPepper(): string {
  const secret = process.env.JWT_ACCESS_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new Error('JWT_ACCESS_SECRET is required for pickup OTP tests');
  }
  return secret;
}

describe('Commute trip lifecycle (integration)', () => {
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
        const rides = await dataSource.getRepository(Ride).find({
          where: { driverId: ctx.userId },
        });
        for (const ride of rides) {
          await dataSource.getRepository(RatingTask).delete({ rideId: ride.id });
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

  async function fundedDriver() {
    const { login, wallet } = await createAuthenticatedUser();
    const vehicle = await vehiclesService.create(login.user.id, {
      vehicleType: VehicleType.CAR,
      make: 'Honda',
      model: 'City',
      variant: 'ZX',
      registrationNumber: `MH12${Date.now().toString().slice(-6)}`,
      registrationYear: 2024,
      color: 'Blue',
      seatingCapacity: 5,
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
      amount: 10000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('commute-trip-driver'),
    });
    return { login, wallet, vehicle };
  }

  async function fundedPassenger() {
    const { login, wallet } = await createAuthenticatedUser();
    await markVerificationVerified(
      verificationService,
      dataSource,
      login.user.id,
      VerificationType.IDENTITY,
    );
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: 5000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('commute-trip-pass'),
    });
    return { login, wallet };
  }

  async function publishCommute(driver: Awaited<ReturnType<typeof fundedDriver>>) {
    const response = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.COMMUTE,
        vehicleId: driver.vehicle.id,
        source: 'Gurgaon',
        destination: 'Noida',
        departureDate: '2026-09-15',
        departureTime: '08:30',
        totalSeats: 4,
        pricePerSeat: 100,
      })
      .expect(201);
    return response.body as { id: string };
  }

  async function bookAndAccept(
    driverToken: string,
    passengerToken: string,
    rideId: string,
  ) {
    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passengerToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('commute-trip-book'))
      .send({
        rideId,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/accept`)
      .set('Authorization', `Bearer ${driverToken}`)
      .expect(200);

    return booking.body as { id: string };
  }

  it('driver can start COMMUTE ride → IN_PROGRESS', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const ride = await publishCommute(driver);
    await bookAndAccept(
      driver.login.accessToken,
      passenger.login.accessToken,
      ride.id,
    );

    const started = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    expect(started.body.status).toBe(RideStatus.IN_PROGRESS);
    expect(started.body.rideType).toBe(RideType.COMMUTE);

    const row = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(row.status).toBe(RideStatus.IN_PROGRESS);
  });

  it('non-owner cannot start COMMUTE ride', async () => {
    const driver = await fundedDriver();
    const other = await fundedDriver();
    const ride = await publishCommute(driver);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${other.login.accessToken}`)
      .expect(404);
  });

  it('COMMUTE pickup OTP works after start; wrong OTP rejected', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const ride = await publishCommute(driver);
    const booking = await bookAndAccept(
      driver.login.accessToken,
      passenger.login.accessToken,
      ride.id,
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const row = await dataSource.getRepository(Booking).findOneByOrFail({
      id: booking.id,
    });
    expect(row.pickupStatus).toBe(BookingPickupStatus.WAITING_FOR_PICKUP);
    expect(row.pickupOtpCiphertext).toBeTruthy();

    await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ otp: '0000' })
      .expect(400);

    const otp = decryptPickupOtp(row.pickupOtpCiphertext!, pickupOtpPepper());
    const verified = await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ otp })
      .expect(200);

    expect(verified.body.pickupStatus).toBe(BookingPickupStatus.PICKED_UP);

    const after = await dataSource.getRepository(Booking).findOneByOrFail({
      id: booking.id,
    });
    expect(after.pickupStatus).toBe(BookingPickupStatus.PICKED_UP);
    expect(after.pickupVerifiedAt).not.toBeNull();
  });

  it('COMMUTE cannot complete before start or before pickup', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const ride = await publishCommute(driver);
    await bookAndAccept(
      driver.login.accessToken,
      passenger.login.accessToken,
      ride.id,
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(409);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(409);
  });

  it('COMMUTE full lifecycle creates rating tasks and settles prepaid fare once', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const ride = await publishCommute(driver);
    const booking = await bookAndAccept(
      driver.login.accessToken,
      passenger.login.accessToken,
      ride.id,
    );

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    const complete = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    expect(complete.body.status).toBe(RideStatus.COMPLETED);
    expect(complete.body.commuteSettlement).toMatchObject({
      settledBookingCount: 1,
      driverSettlementTotal: '100',
      platformMarginTotal: '10',
    });

    const tasks = await dataSource.getRepository(RatingTask).find({
      where: { rideId: ride.id },
    });
    expect(tasks.length).toBe(2);

    const stored = await dataSource.getRepository(Booking).findOneByOrFail({
      id: booking.id,
    });
    expect(stored.status).toBe(BookingStatus.COMPLETED);
  });
});
