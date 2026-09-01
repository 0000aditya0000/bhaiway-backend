import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { BookingsModule } from '../bookings/bookings.module';
import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingPaymentMethod,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { RatingsModule } from '../ratings/ratings.module';
import { RatingTask } from '../ratings/entities/rating-task.entity';
import { RatingTaskStatus } from '../ratings/enums/rating.enums';
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
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import { startRideAndVerifyAllPickups } from '../rides/test/ride-trip-test.helpers';

function pickupOtpPepper(): string {
  const secret = process.env.JWT_ACCESS_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new Error('JWT_ACCESS_SECRET is required for pickup OTP tests');
  }
  return secret;
}

describe('Ratings foundation (integration)', () => {
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
        RatingsModule,
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
  }, 30000);

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

  async function createAuthenticatedUser(displayName?: string) {
    const phone = `+91${Date.now().toString().slice(-9)}${Math.floor(
      Math.random() * 10,
    )}`;
    const login = await authService.loginOrRegisterWithVerifiedIdentity({
      phone,
      verified: true,
    });
    if (displayName) {
      await dataSource.getRepository(UserProfile).update(
        { userId: login.user.id },
        { displayName, firstName: displayName },
      );
    }
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
    const { login, wallet } = await createAuthenticatedUser('Driver');
    const vehicle = await vehiclesService.create(login.user.id, {
      vehicleType: VehicleType.CAR,
      make: 'Honda',
      model: 'City',
      variant: 'ZX',
      registrationNumber: `MH12${Date.now().toString().slice(-6)}${Math.floor(
        Math.random() * 10,
      )}`,
      registrationYear: 2024,
      color: 'Blue',
      seatingCapacity: 5,
    });
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
    await markVerified(login.user.id, VerificationType.VEHICLE);
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: credit,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('ratings-driver'),
    });
    return { login, wallet, vehicle };
  }

  async function fundedPassenger(credit = 5000n, displayName = 'Passenger') {
    const { login, wallet } = await createAuthenticatedUser(displayName);
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: credit,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('ratings-passenger'),
    });
    return { login, wallet };
  }

  async function publishRegular(
    driver: Awaited<ReturnType<typeof fundedDriver>>,
    totalSeats = 4,
  ) {
    const response = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.REGULAR,
        vehicleId: driver.vehicle.id,
        source: 'Rating Source',
        destination: 'Rating Dest',
        departureDate: '2026-12-01',
        departureTime: '09:00',
        totalSeats,
        pricePerSeat: 100,
      })
      .expect(201);
    return response.body as { id: string };
  }

  async function completeRegularRideWithPassengers(
    driver: Awaited<ReturnType<typeof fundedDriver>>,
    passengers: Awaited<ReturnType<typeof fundedPassenger>>[],
    seatsPerBooking: number[] = passengers.map(() => 1),
  ) {
    const ride = await publishRegular(driver, Math.max(4, passengers.length));
    const bookings: Booking[] = [];

    for (let i = 0; i < passengers.length; i += 1) {
      const passenger = passengers[i];
      const seats = seatsPerBooking[i] ?? 1;
      const bookingRes = await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .send({
          rideId: ride.id,
          seats,
          paymentMethod: BookingPaymentMethod.PAY_LATER,
        })
        .expect(201);
      bookings.push(
        await dataSource.getRepository(Booking).findOneByOrFail({
          id: bookingRes.body.id,
        }),
      );
    }

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    return { ride, bookings };
  }

  function taskFor(
    tasks: RatingTask[],
    fromUserId: string,
    toUserId: string,
    bookingId: string,
  ) {
    return tasks.find(
      (task) =>
        task.fromUserId === fromUserId &&
        task.toUserId === toUserId &&
        task.bookingId === bookingId,
    );
  }

  it('creates driver↔passenger rating tasks on ride completion', async () => {
    const driver = await fundedDriver();
    const p1 = await fundedPassenger(5000n, 'Alice');
    const p2 = await fundedPassenger(5000n, 'Bob');
    const { ride, bookings } = await completeRegularRideWithPassengers(driver, [
      p1,
      p2,
    ]);

    const tasks = await dataSource.getRepository(RatingTask).find({
      where: { rideId: ride.id },
      order: { id: 'ASC' },
    });

    expect(tasks).toHaveLength(4);
    for (const booking of bookings) {
      expect(
        taskFor(tasks, driver.login.user.id, booking.passengerId, booking.id),
      ).toMatchObject({ status: RatingTaskStatus.PENDING, rating: null });
      expect(
        taskFor(tasks, booking.passengerId, driver.login.user.id, booking.id),
      ).toMatchObject({ status: RatingTaskStatus.PENDING, rating: null });
    }
  });

  it('multi-seat booking creates one rating task per passenger direction', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const { ride, bookings } = await completeRegularRideWithPassengers(
      driver,
      [passenger],
      [3],
    );

    const tasks = await dataSource.getRepository(RatingTask).find({
      where: { rideId: ride.id },
    });
    expect(bookings[0].seats).toBe(3);
    expect(tasks).toHaveLength(2);
  });

  it('ride completion retry does not duplicate rating tasks', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const { ride } = await completeRegularRideWithPassengers(driver, [
      passenger,
    ]);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const count = await dataSource.getRepository(RatingTask).count({
      where: { rideId: ride.id },
    });
    expect(count).toBe(2);
  });

  it('driver and passenger can submit ratings; pending list updates', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const { ride, bookings } = await completeRegularRideWithPassengers(driver, [
      passenger,
    ]);

    const tasks = await dataSource.getRepository(RatingTask).find({
      where: { rideId: ride.id },
    });
    const driverTask = taskFor(
      tasks,
      driver.login.user.id,
      passenger.login.user.id,
      bookings[0].id,
    )!;
    const passengerTask = taskFor(
      tasks,
      passenger.login.user.id,
      driver.login.user.id,
      bookings[0].id,
    )!;

    const driverPending = await request(app.getHttpServer())
      .get('/ratings/pending')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(driverPending.body.items).toHaveLength(1);
    expect(driverPending.body.items[0].taskId).toBe(driverTask.id);
    expect(driverPending.body.items[0].role).toBe('PASSENGER');

    await request(app.getHttpServer())
      .post('/ratings')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        taskId: driverTask.id,
        rating: 5,
        comment: 'Great passenger',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/ratings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .send({
        taskId: passengerTask.id,
        rating: 4,
        comment: '  ',
      })
      .expect(200);

    const driverPendingAfter = await request(app.getHttpServer())
      .get('/ratings/pending')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(driverPendingAfter.body.items).toHaveLength(0);

    const passengerRow = await dataSource
      .getRepository(RatingTask)
      .findOneByOrFail({ id: passengerTask.id });
    expect(passengerRow.comment).toBeNull();
    expect(passengerRow.status).toBe(RatingTaskStatus.COMPLETED);

    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.COMPLETED);
  });

  it('skip keeps task pending and records skippedAt', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const { ride, bookings } = await completeRegularRideWithPassengers(driver, [
      passenger,
    ]);
    const task = await dataSource.getRepository(RatingTask).findOneByOrFail({
      where: {
        rideId: ride.id,
        fromUserId: driver.login.user.id,
        bookingId: bookings[0].id,
      },
    });

    const first = await request(app.getHttpServer())
      .post(`/ratings/${task.id}/skip`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(first.body.status).toBe('PENDING');
    expect(first.body.skippedAt).toBeTruthy();

    const second = await request(app.getHttpServer())
      .post(`/ratings/${task.id}/skip`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(second.body.skippedAt).toBe(first.body.skippedAt);

    const pending = await request(app.getHttpServer())
      .get('/ratings/pending')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(pending.body.items).toHaveLength(1);
    expect(pending.body.items[0].skippedAt).toBeTruthy();
  });

  it('rejects invalid ratings and long comments', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const { ride, bookings } = await completeRegularRideWithPassengers(driver, [
      passenger,
    ]);
    const task = await dataSource.getRepository(RatingTask).findOneByOrFail({
      where: {
        rideId: ride.id,
        fromUserId: driver.login.user.id,
        bookingId: bookings[0].id,
      },
    });

    await request(app.getHttpServer())
      .post('/ratings')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ taskId: task.id, rating: 0 })
      .expect(400);

    await request(app.getHttpServer())
      .post('/ratings')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ taskId: task.id, rating: 6 })
      .expect(400);

    await request(app.getHttpServer())
      .post('/ratings')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ taskId: task.id, rating: 4.5 })
      .expect(400);

    await request(app.getHttpServer())
      .post('/ratings')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ taskId: task.id, rating: 5, comment: 'x'.repeat(501) })
      .expect(400);
  });

  it('prevents cross-user task access and duplicate submission', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const other = await fundedPassenger();
    const { ride, bookings } = await completeRegularRideWithPassengers(driver, [
      passenger,
    ]);
    const task = await dataSource.getRepository(RatingTask).findOneByOrFail({
      where: {
        rideId: ride.id,
        fromUserId: driver.login.user.id,
        bookingId: bookings[0].id,
      },
    });

    await request(app.getHttpServer())
      .post('/ratings')
      .set('Authorization', `Bearer ${other.login.accessToken}`)
      .send({ taskId: task.id, rating: 5 })
      .expect(404);

    await request(app.getHttpServer())
      .post(`/ratings/${task.id}/skip`)
      .set('Authorization', `Bearer ${other.login.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .post('/ratings')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ taskId: task.id, rating: 5 })
      .expect(200);

    await request(app.getHttpServer())
      .post('/ratings')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ taskId: task.id, rating: 5 })
      .expect(200);

    await request(app.getHttpServer())
      .post('/ratings')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ taskId: task.id, rating: 4 })
      .expect(409);

    const walletTxCount = await dataSource
      .getRepository(WalletTransaction)
      .count({
        where: { referenceId: In([bookings[0].id, ride.id]) },
      });
    expect(walletTxCount).toBe(0);
  });

  it('aggregates received ratings excluding pending/skipped tasks', async () => {
    const driver = await fundedDriver();
    const p1 = await fundedPassenger(5000n, 'Rater1');
    const p2 = await fundedPassenger(5000n, 'Rater2');
    const { ride, bookings } = await completeRegularRideWithPassengers(driver, [
      p1,
      p2,
    ]);

    const tasks = await dataSource.getRepository(RatingTask).find({
      where: { rideId: ride.id },
    });

    const p1Task = taskFor(
      tasks,
      p1.login.user.id,
      driver.login.user.id,
      bookings[0].id,
    )!;
    const p2Task = taskFor(
      tasks,
      p2.login.user.id,
      driver.login.user.id,
      bookings[1].id,
    )!;

    await request(app.getHttpServer())
      .post('/ratings')
      .set('Authorization', `Bearer ${p1.login.accessToken}`)
      .send({ taskId: p1Task.id, rating: 5, comment: 'Excellent' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/ratings')
      .set('Authorization', `Bearer ${p2.login.accessToken}`)
      .send({ taskId: p2Task.id, rating: 3 })
      .expect(200);

    const driverToP1 = taskFor(
      tasks,
      driver.login.user.id,
      p1.login.user.id,
      bookings[0].id,
    )!;
    await request(app.getHttpServer())
      .post(`/ratings/${driverToP1.id}/skip`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const summary = await request(app.getHttpServer())
      .get(`/ratings/user/${driver.login.user.id}`)
      .set('Authorization', `Bearer ${p1.login.accessToken}`)
      .expect(200);

    expect(summary.body.totalRatings).toBe(2);
    expect(summary.body.averageRating).toBe(4);
    expect(summary.body.items).toHaveLength(2);
  });

  it('REGULAR PAY_LATER driver completion succeeds with zero passenger wallet', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(0n);
    const { ride } = await completeRegularRideWithPassengers(driver, [
      passenger,
    ]);

    const tasks = await dataSource.getRepository(RatingTask).count({
      where: { rideId: ride.id },
    });
    expect(tasks).toBe(2);

    const booking = await dataSource.getRepository(Booking).findOneByOrFail({
      rideId: ride.id,
    });
    expect(booking.paymentStatus).toBe('UNPAID');
  });
});
