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
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { deleteChatForBookingIds } from '../chat/test/chat-test.helpers';
import { RatingTask } from '../ratings/entities/rating-task.entity';
import { SettingsModule } from '../settings/settings.module';
import { SettingsService } from '../settings/settings.service';
import { UserProfile } from '../users/entities/user-profile.entity';
import { UserVerification } from '../verification/entities/user-verification.entity';
import {
  VerificationStatus,
  VerificationType,
} from '../verification/enums/verification.enums';
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
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { Ride } from './entities/ride.entity';
import { RideStatus, RideType } from './enums/ride.enums';
import { RidesModule } from './rides.module';
import { ASSURED_TEST_ROUTE } from './test/assured-ride-test.helpers';
import { RidesService } from './rides.service';
import { startRideAndVerifyAllPickups } from './test/ride-trip-test.helpers';

function pickupOtpPepper(): string {
  const secret = process.env.JWT_ACCESS_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new Error('JWT_ACCESS_SECRET is required for pickup OTP tests');
  }
  return secret;
}

describe('Ride completion Phase 3 (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  let ridesService: RidesService;
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
    ridesService = moduleRef.get(RidesService);
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        const passengerBookings = await dataSource.getRepository(Booking).find({
          where: { passengerId: ctx.userId },
          select: { id: true },
        });
        const passengerBookingIds = passengerBookings.map((b) => b.id);
        if (passengerBookingIds.length > 0) {
          await dataSource
            .getRepository(RatingTask)
            .createQueryBuilder()
            .delete()
            .where('booking_id IN (:...ids)', { ids: passengerBookingIds })
            .execute();
        }
        await deleteChatForBookingIds(dataSource, passengerBookingIds);
        await dataSource.getRepository(Booking).delete({
          passengerId: ctx.userId,
        });
        const rides = await dataSource.getRepository(Ride).find({
          where: { driverId: ctx.userId },
        });
        for (const ride of rides) {
          const rideBookings = await dataSource.getRepository(Booking).find({
            where: { rideId: ride.id },
            select: { id: true },
          });
          const rideBookingIds = rideBookings.map((b) => b.id);
          if (rideBookingIds.length > 0) {
            await dataSource
              .getRepository(RatingTask)
              .createQueryBuilder()
              .delete()
              .where('booking_id IN (:...ids)', { ids: rideBookingIds })
              .execute();
          }
          await dataSource
            .getRepository(RatingTask)
            .delete({ rideId: ride.id });
          await deleteChatForBookingIds(dataSource, rideBookingIds);
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
      idempotencyKey: uniqueIdempotencyKey('complete-driver'),
    });
    return { login, wallet, vehicle };
  }

  async function fundedPassenger(credit = 1000n) {
    const { login, wallet } = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: credit,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('complete-pass'),
    });
    return { login, wallet };
  }

  it('driver can complete Regular ride without deposit release', async () => {
    const driver = await fundedDriver();
    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.REGULAR,
        vehicleId: driver.vehicle.id,
        source: 'Complete Regular A',
        destination: 'Complete Regular B',
        departureDate: '2026-10-01',
        departureTime: '09:00',
        totalSeats: 3,
        pricePerSeat: 200,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(409);

    await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const response = await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    expect(response.body).toMatchObject({
      rideId: ride.body.id,
      status: RideStatus.COMPLETED,
      rideType: RideType.REGULAR,
      alreadyCompleted: false,
    });
    expect(response.body.releasedDeposits).toBeUndefined();

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          walletId: driver.wallet.id,
          transactionType: WalletTransactionType.HOLD_RELEASE,
        },
      }),
    ).toBe(0);
  });

  it('assured completion releases driver and rider deposits; idempotent retry', async () => {
    const driver = await fundedDriver();
    const passengerA = await fundedPassenger(2000n);
    const passengerB = await fundedPassenger(2000n);

    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        ...ASSURED_TEST_ROUTE,
        vehicleId: driver.vehicle.id,
        source: 'Complete Assured A',
        destination: 'Complete Assured B',
        departureDate: '2026-10-02',
        departureTime: '10:00',
        totalSeats: 4,
        pricePerSeat: 500,
      })
      .expect(201);
    expect(ride.body.assuredDepositAmount).toBe('100');

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passengerA.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('comp-a'))
      .send({
        rideId: ride.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passengerB.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('comp-b'))
      .send({
        rideId: ride.body.id,
        seats: 2,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      })
      .expect(201);

    const driverBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driver.wallet.id });
    expect(driverBefore.purchasedHeld).toBe('100');

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.body.id,
      pickupOtpPepper(),
    );

    const completed = await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    expect(completed.body).toMatchObject({
      status: RideStatus.COMPLETED,
      rideType: RideType.ASSURED,
      alreadyCompleted: false,
      releasedDeposits: {
        driver: '100',
        riders: '75',
        riderCount: 2,
      },
    });

    const driverHold = await dataSource.getRepository(WalletHold).findOneByOrFail({
      id: (
        await dataSource.getRepository(Ride).findOneByOrFail({
          id: ride.body.id,
        })
      ).driverDepositHoldId!,
    });
    expect(driverHold.status).toBe(WalletHoldStatus.RELEASED);
    expect(driverHold.releasedAt).toBeTruthy();

    const driverAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driver.wallet.id });
    expect(driverAfter.purchasedHeld).toBe('0');
    expect(driverAfter.purchasedAvailable).toBe('10000');

    const driverRelease = await dataSource
      .getRepository(WalletTransaction)
      .find({
        where: {
          walletId: driver.wallet.id,
          transactionType: WalletTransactionType.HOLD_RELEASE,
        },
      });
    expect(driverRelease).toHaveLength(1);
    expect(driverRelease[0].direction).toBe(WalletTransactionDirection.CREDIT);
    expect(driverRelease[0].amount).toBe('100');

    for (const passenger of [passengerA, passengerB]) {
      const hold = await dataSource.getRepository(WalletHold).findOneByOrFail({
        walletId: passenger.wallet.id,
      });
      expect(hold.status).toBe(WalletHoldStatus.RELEASED);
      const balance = await dataSource
        .getRepository(WalletBalance)
        .findOneByOrFail({ walletId: passenger.wallet.id });
      expect(balance.purchasedHeld).toBe('0');
      expect(
        await dataSource.getRepository(WalletTransaction).count({
          where: {
            walletId: passenger.wallet.id,
            transactionType: WalletTransactionType.HOLD_RELEASE,
          },
        }),
      ).toBe(1);
    }

    const bookings = await dataSource.getRepository(Booking).find({
      where: { rideId: ride.body.id },
    });
    expect(bookings.every((b) => b.status === BookingStatus.COMPLETED)).toBe(
      true,
    );

    const retry = await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(retry.body.alreadyCompleted).toBe(true);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          walletId: driver.wallet.id,
          transactionType: WalletTransactionType.HOLD_RELEASE,
        },
      }),
    ).toBe(1);
  });

  it('rejects unauthorized completion and invalid states; PATCH cannot set COMPLETED', async () => {
    const driver = await fundedDriver();
    const other = await fundedDriver();
    const passenger = await fundedPassenger();

    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.REGULAR,
        vehicleId: driver.vehicle.id,
        source: 'Auth Complete A',
        destination: 'Auth Complete B',
        departureDate: '2026-10-03',
        departureTime: '11:00',
        totalSeats: 2,
        pricePerSeat: 100,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/complete`)
      .expect(401);

    await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/complete`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/complete`)
      .set('Authorization', `Bearer ${other.login.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .patch(`/rides/${ride.body.id}`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ status: RideStatus.COMPLETED })
      .expect(400);

    await dataSource
      .getRepository(Ride)
      .update({ id: ride.body.id }, { status: RideStatus.DRAFT });
    await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(409);

    await dataSource
      .getRepository(Ride)
      .update({ id: ride.body.id }, { status: RideStatus.CANCELLED });
    await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(409);
  });

  it('leaves cancelled booking cancelled and does not release its hold', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(500n);

    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        ...ASSURED_TEST_ROUTE,
        vehicleId: driver.vehicle.id,
        source: 'Cancel Hold A',
        destination: 'Cancel Hold B',
        departureDate: '2026-10-04',
        departureTime: '12:00',
        totalSeats: 4,
        pricePerSeat: 500,
      })
      .expect(201);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('cancel-keep'))
      .send({
        rideId: ride.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      })
      .expect(201);

    await dataSource.getRepository(Booking).update(
      { id: booking.body.id },
      { status: BookingStatus.CANCELLED },
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const bookingRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(bookingRow.status).toBe(BookingStatus.CANCELLED);

    const riderHold = await dataSource.getRepository(WalletHold).findOneByOrFail({
      id: bookingRow.walletHoldId!,
    });
    expect(riderHold.status).toBe(WalletHoldStatus.ACTIVE);
  });

  it('release uses hold amount snapshot after admin percentage change', async () => {
    const driver = await fundedDriver();
    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        ...ASSURED_TEST_ROUTE,
        vehicleId: driver.vehicle.id,
        source: 'Snapshot A',
        destination: 'Snapshot B',
        departureDate: '2026-10-05',
        departureTime: '13:00',
        totalSeats: 4,
        pricePerSeat: 500,
      })
      .expect(201);

    const settings = moduleRef.get(SettingsService);
    const previous = await settings.getAssuredRideDepositPercentage();
    await settings.setAssuredRideDepositPercentage(7);

    try {
      await request(app.getHttpServer())
        .post(`/rides/${ride.body.id}/start`)
        .set('Authorization', `Bearer ${driver.login.accessToken}`)
        .expect(200);

      const completed = await request(app.getHttpServer())
        .post(`/rides/${ride.body.id}/complete`)
        .set('Authorization', `Bearer ${driver.login.accessToken}`)
        .expect(200);

      expect(completed.body.releasedDeposits.driver).toBe('100');
    } finally {
      await settings.setAssuredRideDepositPercentage(previous);
    }
  });

  it('failure during release rolls back ride completion', async () => {
    const driver = await fundedDriver();
    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        ...ASSURED_TEST_ROUTE,
        vehicleId: driver.vehicle.id,
        source: 'Rollback Complete A',
        destination: 'Rollback Complete B',
        departureDate: '2026-10-06',
        departureTime: '14:00',
        totalSeats: 2,
        pricePerSeat: 500,
      })
      .expect(201);

    const balanceBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driver.wallet.id });

    await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const spy = jest
      .spyOn(walletService, 'releaseHoldInTransaction')
      .mockRejectedValue(new Error('forced release failure'));

    try {
      await expect(
        ridesService.complete(driver.login.user.id, ride.body.id),
      ).rejects.toThrow('forced release failure');
    } finally {
      spy.mockRestore();
    }

    const rideRow = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.body.id,
    });
    expect(rideRow.status).toBe(RideStatus.IN_PROGRESS);

    const balanceAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driver.wallet.id });
    expect(balanceAfter.purchasedAvailable).toBe(
      balanceBefore.purchasedAvailable,
    );
    expect(balanceAfter.purchasedHeld).toBe(balanceBefore.purchasedHeld);
  });

  it('concurrent completion cannot double-release', async () => {
    const driver = await fundedDriver();
    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        ...ASSURED_TEST_ROUTE,
        vehicleId: driver.vehicle.id,
        source: 'Conc Complete A',
        destination: 'Conc Complete B',
        departureDate: '2026-10-07',
        departureTime: '15:00',
        totalSeats: 2,
        pricePerSeat: 500,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/rides/${ride.body.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const results = await Promise.allSettled([
      ridesService.complete(driver.login.user.id, ride.body.id),
      ridesService.complete(driver.login.user.id, ride.body.id),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          walletId: driver.wallet.id,
          transactionType: WalletTransactionType.HOLD_RELEASE,
        },
      }),
    ).toBe(1);

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driver.wallet.id });
    expect(balance.purchasedHeld).toBe('0');
    expect(balance.purchasedAvailable).toBe('10000');
  });
});
