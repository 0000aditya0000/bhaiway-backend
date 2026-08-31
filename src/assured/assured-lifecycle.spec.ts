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
  BookingCancellationReason,
  BookingFarePayment,
  BookingMode,
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import {
  UserCoupon,
  UserCouponStatus,
  UserCouponType,
} from '../coupons/entities/user-coupon.entity';
import { SettingsModule } from '../settings/settings.module';
import { SettingsService } from '../settings/settings.service';
import { UserProfile } from '../users/entities/user-profile.entity';
import { UsersModule } from '../users/users.module';
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
import {
  WalletPointLot,
  WalletPointSource,
} from '../wallet/entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { PLATFORM_WALLET_ID } from '../wallet/platform-wallet.constants';
import {
  assertSafeTestDatabaseUrl,
  assertWalletBalanceMatchesLots,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { Ride } from '../rides/entities/ride.entity';
import {
  RegularSeatsPolicy,
  RideCancellationReason,
  RideStatus,
  RideType,
} from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import { ASSURED_TEST_ROUTE, withAssuredPublishHeaders } from '../rides/test/assured-ride-test.helpers';
import { startRideAndVerifyAllPickups } from '../rides/test/ride-trip-test.helpers';

function pickupOtpPepper(): string {
  const secret = process.env.JWT_ACCESS_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new Error('JWT_ACCESS_SECRET is required for pickup OTP tests');
  }
  return secret;
}
import { AssuredModule } from './assured.module';
import { calculatePartialFillCompensation } from './assured-lifecycle.math';
import { AssuredGeographicQueue } from './entities/assured-geographic-queue.entity';
import { AssuredLifecycleEvent } from './entities/assured-lifecycle-event.entity';
import { PassengerAssuredDepositPenalty } from './entities/passenger-assured-deposit-penalty.entity';
import { calculateAssuredHalfTime } from './assured-timing';

const FUTURE_DATE = '2099-06-15';
const FUTURE_TIME = '10:00';
const PAST_DATE = '2020-01-01';
const PAST_TIME = '10:00';

describe('Assured lifecycle Phase 4 (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  let settingsService: SettingsService;
  const tracked: TestWalletContext[] = [];
  let originalPercentage: number;

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
        AssuredModule,
        UsersModule,
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
    settingsService = moduleRef.get(SettingsService);
    originalPercentage =
      await settingsService.getAssuredRideDepositPercentage();
    await settingsService.setAssuredRideDepositPercentage(5);
    await purgeStaleAssuredTestCorridorRides();
  });

  async function purgeStaleAssuredTestCorridorRides(): Promise<void> {
    const staleRides = await dataSource.getRepository(Ride).find({
      where: {
        rideType: RideType.ASSURED,
        sourceLatitude: ASSURED_TEST_ROUTE.sourceLatitude,
        sourceLongitude: ASSURED_TEST_ROUTE.sourceLongitude,
        destinationLatitude: ASSURED_TEST_ROUTE.destinationLatitude,
        destinationLongitude: ASSURED_TEST_ROUTE.destinationLongitude,
      },
    });
    if (staleRides.length === 0) {
      return;
    }
    const rideIds = staleRides.map((ride) => ride.id);
    const queueIds = [
      ...new Set(
        staleRides
          .map((ride) => ride.assuredQueueId)
          .filter((id): id is string => id != null),
      ),
    ];
    await dataSource.getRepository(AssuredLifecycleEvent).delete({
      rideId: In(rideIds),
    });
    await dataSource.getRepository(Booking).delete({ rideId: In(rideIds) });
    for (const ride of staleRides) {
      if (ride.assuredQueueKey) {
        await dataSource.query(
          `DELETE FROM assured_queue_events WHERE queue_key = $1`,
          [ride.assuredQueueKey],
        );
      }
    }
    await dataSource.getRepository(Ride).delete({ id: In(rideIds) });
    for (const queueId of queueIds) {
      const remaining = await dataSource.getRepository(Ride).count({
        where: { assuredQueueId: queueId },
      });
      if (remaining === 0) {
        await dataSource
          .getRepository(AssuredGeographicQueue)
          .delete({ id: queueId });
      }
    }
  }

  afterEach(async () => {
    await settingsService.setAssuredRideDepositPercentage(5);
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await dataSource.getRepository(UserCoupon).delete({
          userId: ctx.userId,
        });
        await dataSource.getRepository(PassengerAssuredDepositPenalty).delete({
          userId: ctx.userId,
        });

        const rides = await dataSource.getRepository(Ride).find({
          where: { driverId: ctx.userId },
        });
        const queueIds = [
          ...new Set(
            rides
              .map((ride) => ride.assuredQueueId)
              .filter((id): id is string => id != null),
          ),
        ];
        if (rides.length > 0) {
          await dataSource.getRepository(AssuredLifecycleEvent).delete({
            rideId: In(rides.map((r) => r.id)),
          });
        }

        await dataSource.getRepository(Booking).delete({
          passengerId: ctx.userId,
        });
        for (const ride of rides) {
          await dataSource.getRepository(Booking).delete({ rideId: ride.id });
          if (ride.assuredQueueKey) {
            await dataSource.query(
              `DELETE FROM assured_queue_events WHERE queue_key = $1`,
              [ride.assuredQueueKey],
            );
          }
        }
        await dataSource.getRepository(Ride).delete({ driverId: ctx.userId });
        for (const queueId of queueIds) {
          const remaining = await dataSource.getRepository(Ride).count({
            where: { assuredQueueId: queueId },
          });
          if (remaining === 0) {
            await dataSource
              .getRepository(AssuredGeographicQueue)
              .delete({ id: queueId });
          }
        }
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
    if (settingsService) {
      await settingsService.setAssuredRideDepositPercentage(originalPercentage);
    }
    if (app) {
      await app.close();
    }
  });

  async function createAuthenticatedUser() {
    const phone = `+91${Date.now()}${Math.floor(Math.random() * 1_000_000)}`
      .replace(/\D/g, '')
      .slice(-10)
      .padStart(10, '0');
    const login = await authService.loginOrRegisterWithVerifiedIdentity({
      phone: `+91${phone}`,
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
        idempotencyKey: uniqueIdempotencyKey('lc-driver'),
      });
    }
    return { login, wallet, vehicle };
  }

  async function fundedPassenger(credit = 1000n) {
    const { login, wallet } = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);
    if (credit > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: credit,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('lc-pass'),
      });
    }
    return { login, wallet };
  }

  async function publishAssuredRide(
    driver: Awaited<ReturnType<typeof fundedDriver>>,
    overrides: Record<string, unknown> = {},
  ) {
    const response = await request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(driver.login.accessToken))
      .send({
        rideType: RideType.ASSURED,
        vehicleId: driver.vehicle.id,
        source: 'Lifecycle Source',
        destination: 'Lifecycle Dest',
        departureDate: FUTURE_DATE,
        departureTime: FUTURE_TIME,
        totalSeats: 4,
        pricePerSeat: 500,
        ...ASSURED_TEST_ROUTE,
        ...overrides,
      })
      .expect(201);
    return response.body as { id: string; assuredDepositAmount: string };
  }

  async function bookAssured(
    passenger: Awaited<ReturnType<typeof fundedPassenger>>,
    rideId: string,
    seats = 1,
    options: {
      farePayment?: BookingFarePayment;
    } = {},
  ) {
    const response = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('lc-book'))
      .send({
        rideId,
        seats,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        ...(options.farePayment
          ? { farePayment: options.farePayment }
          : {}),
      })
      .expect(201);
    return response.body as {
      id: string;
      securityDepositAmount: string | null;
      totalAmount: string;
      bookingMode: BookingMode;
      farePayment?: BookingFarePayment | null;
      farePaymentStatus?: BookingPaymentStatus;
    };
  }

  function tomorrowDate(): string {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  async function pushCreatedAtPastHalfTime(rideId: string) {
    await dataSource.query(
      `UPDATE rides SET created_at = NOW() - INTERVAL '10 days' WHERE id = $1`,
      [rideId],
    );
  }

  async function issueUnusedDepositCoupon(userId: string) {
    return dataSource.getRepository(UserCoupon).save(
      dataSource.getRepository(UserCoupon).create({
        userId,
        couponType: UserCouponType.NEXT_ASSURED_DEPOSIT_FREE,
        status: UserCouponStatus.UNUSED,
        sourceReferenceType: 'TEST_SEED',
        sourceReferenceId: uniqueIdempotencyKey('coupon-seed'),
        usedAt: null,
        usedBookingId: null,
        expiresAt: null,
      }),
    );
  }

  async function withZeroedPlatformFunds<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    const balanceRepo = dataSource.getRepository(WalletBalance);
    const lotRepo = dataSource.getRepository(WalletPointLot);
    const balance = await balanceRepo.findOneByOrFail({
      walletId: PLATFORM_WALLET_ID,
    });
    const lots = await lotRepo.find({
      where: { walletId: PLATFORM_WALLET_ID },
    });
    const balanceSnap = {
      purchasedAvailable: balance.purchasedAvailable,
      promotionalAvailable: balance.promotionalAvailable,
      driverEarnedAvailable: balance.driverEarnedAvailable,
    };
    const lotSnaps = lots.map((lot) => ({
      id: lot.id,
      availableAmount: lot.availableAmount,
    }));

    await balanceRepo.update(
      { walletId: PLATFORM_WALLET_ID },
      {
        purchasedAvailable: '0',
        promotionalAvailable: '0',
        driverEarnedAvailable: '0',
      },
    );
    for (const lot of lots) {
      await lotRepo.update({ id: lot.id }, { availableAmount: '0' });
    }

    try {
      return await fn();
    } finally {
      await balanceRepo.update({ walletId: PLATFORM_WALLET_ID }, balanceSnap);
      for (const snap of lotSnaps) {
        await lotRepo.update(
          { id: snap.id },
          { availableAmount: snap.availableAmount },
        );
      }
      await assertWalletBalanceMatchesLots(dataSource, PLATFORM_WALLET_ID);
    }
  }

  it('driver cancel Assured before departure: deposit CONSUMED, riders RELEASED, 60/40 split, statuses, IDOR, idempotent, zero-rider platform', async () => {
    const driver = await fundedDriver();
    const passengerA = await fundedPassenger();
    const passengerB = await fundedPassenger();
    const stranger = await fundedDriver();

    const ride = await publishAssuredRide(driver);
    expect(ride.assuredDepositAmount).toBe('100');

    const bookingA = await bookAssured(passengerA, ride.id, 1);
    const bookingB = await bookAssured(passengerB, ride.id, 1);
    expect(bookingA.securityDepositAmount).toBe('25');
    expect(bookingB.securityDepositAmount).toBe('25');

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${stranger.login.accessToken}`)
      .expect(404);

    const cancelled = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    expect(cancelled.body).toMatchObject({
      rideId: ride.id,
      status: RideStatus.CANCELLED,
      cancellationReason: RideCancellationReason.DRIVER_CANCELLED,
      cancelledBookingCount: 2,
      driverDepositForfeited: '100',
      riderCompensationTotal: '60',
      platformForfeiture: '40',
      alreadyApplied: false,
    });

    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.CANCELLED);

    const driverHold = await dataSource
      .getRepository(WalletHold)
      .findOneByOrFail({ id: rideRow.driverDepositHoldId! });
    expect(driverHold.status).toBe(WalletHoldStatus.CONSUMED);

    for (const bookingId of [bookingA.id, bookingB.id]) {
      const booking = await dataSource
        .getRepository(Booking)
        .findOneByOrFail({ id: bookingId });
      expect(booking.status).toBe(BookingStatus.CANCELLED);
      expect(booking.cancellationReason).toBe(
        BookingCancellationReason.RIDE_CANCELLED,
      );
      const hold = await dataSource
        .getRepository(WalletHold)
        .findOneByOrFail({ id: booking.walletHoldId! });
      expect(hold.status).toBe(WalletHoldStatus.RELEASED);
    }

    for (const passenger of [passengerA, passengerB]) {
      const comp = await dataSource.getRepository(WalletTransaction).findOne({
        where: {
          walletId: passenger.wallet.id,
          transactionType: WalletTransactionType.ASSURED_RIDER_COMPENSATION,
        },
      });
      expect(comp?.amount).toBe('30');
      expect(comp?.direction).toBe(WalletTransactionDirection.CREDIT);
    }

    const platformTx = await dataSource
      .getRepository(WalletTransaction)
      .findOne({
        where: {
          walletId: PLATFORM_WALLET_ID,
          transactionType: WalletTransactionType.ASSURED_PLATFORM_FORFEITURE,
          referenceId: ride.id,
        },
      });
    expect(platformTx?.amount).toBe('40');

    const retry = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(retry.body.alreadyApplied).toBe(true);
    expect(retry.body.riderCompensationTotal).toBe('60');

    const emptyDriver = await fundedDriver();
    const emptyRide = await publishAssuredRide(emptyDriver, {
      source: 'Empty Cancel Source',
      destination: 'Empty Cancel Dest',
    });
    const emptyCancel = await request(app.getHttpServer())
      .post(`/rides/${emptyRide.id}/cancel`)
      .set('Authorization', `Bearer ${emptyDriver.login.accessToken}`)
      .expect(200);
    expect(emptyCancel.body).toMatchObject({
      driverDepositForfeited: '100',
      riderCompensationTotal: '0',
      platformForfeiture: '100',
      cancelledBookingCount: 0,
    });
  });

  it('rider cancel PAY_LATER: deposit to driver, no platform share, 10% penalty, seats restored', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const other = await fundedPassenger();

    const ride = await publishAssuredRide(driver);
    const booking = await bookAssured(passenger, ride.id, 1);
    await bookAssured(other, ride.id, 1);

    const seatsBeforeCancel = (
      await dataSource.getRepository(Ride).findOneByOrFail({ id: ride.id })
    ).availableSeats;

    await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${other.login.accessToken}`)
      .expect(404);

    const driverBalanceBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driver.wallet.id });

    const cancelled = await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    expect(cancelled.body).toMatchObject({
      bookingId: booking.id,
      status: BookingStatus.CANCELLED,
      cancellationReason: BookingCancellationReason.RIDER_CANCELLED,
      seatsRestored: 1,
      securityDepositForfeited: '25',
      farePayment: BookingFarePayment.PAY_LATER,
      fareRefunded: '0',
      driverCompensation: '25',
      platformAmount: '0',
      nextAssuredDepositPercentage: 10,
      partialFillCompensation: null,
      alreadyApplied: false,
    });

    const depositDriverTx = await dataSource
      .getRepository(WalletTransaction)
      .findOneByOrFail({
        walletId: driver.wallet.id,
        transactionType:
          WalletTransactionType.ASSURED_PASSENGER_CANCEL_DEPOSIT_DRIVER,
        referenceId: booking.id,
      });
    expect(depositDriverTx.amount).toBe('25');

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          walletId: PLATFORM_WALLET_ID,
          referenceId: booking.id,
        },
      }),
    ).toBe(0);

    const driverBalanceAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driver.wallet.id });
    expect(BigInt(driverBalanceAfter.driverEarnedAvailable)).toBe(
      BigInt(driverBalanceBefore.driverEarnedAvailable) + 25n,
    );

    const rideAfter = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideAfter.availableSeats).toBe(seatsBeforeCancel + 1);
    expect(rideAfter.status).toBe(RideStatus.ASSURANCE_ACTIVE);
  });

  it('rider cancel PAY_NOW: deposit and fare split separately (30/70), no fare refund', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(5000n);
    const ride = await publishAssuredRide(driver, { pricePerSeat: 700, totalSeats: 2 });

    const booked = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('lc-paynow-cancel'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        farePayment: BookingFarePayment.PAY_NOW,
      })
      .expect(201);
    expect(booked.body.totalAmount).toBe('700');
    expect(booked.body.securityDepositAmount).toBe('35');

    const cancelled = await request(app.getHttpServer())
      .post(`/bookings/${booked.body.id}/cancel`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    expect(cancelled.body).toMatchObject({
      securityDepositForfeited: '35',
      fareRefunded: '0',
      driverCompensation: '245',
      platformAmount: '490',
      nextAssuredDepositPercentage: 10,
    });

    const depositTx = await dataSource
      .getRepository(WalletTransaction)
      .findOneByOrFail({
        walletId: driver.wallet.id,
        transactionType:
          WalletTransactionType.ASSURED_PASSENGER_CANCEL_DEPOSIT_DRIVER,
        referenceId: booked.body.id,
      });
    expect(depositTx.amount).toBe('35');

    const fareDriverTx = await dataSource
      .getRepository(WalletTransaction)
      .findOneByOrFail({
        walletId: driver.wallet.id,
        transactionType:
          WalletTransactionType.ASSURED_PASSENGER_CANCEL_FARE_DRIVER,
        referenceId: booked.body.id,
      });
    expect(fareDriverTx.amount).toBe('210');

    const platformTx = await dataSource
      .getRepository(WalletTransaction)
      .findOneByOrFail({
        walletId: PLATFORM_WALLET_ID,
        transactionType:
          WalletTransactionType.ASSURED_PASSENGER_CANCEL_FARE_PLATFORM,
        referenceId: booked.body.id,
      });
    expect(platformTx.amount).toBe('490');

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          walletId: passenger.wallet.id,
          transactionType: WalletTransactionType.REFUND,
        },
      }),
    ).toBe(0);
  });

  it('rider cancel idempotent retry: no duplicate wallet credits or penalty', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const ride = await publishAssuredRide(driver);
    const booking = await bookAssured(passenger, ride.id, 1);

    const first = await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(first.body.alreadyApplied).toBe(false);

    const retry = await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(retry.body.alreadyApplied).toBe(true);
    expect(retry.body.driverCompensation).toBe(first.body.driverCompensation);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          walletId: driver.wallet.id,
          transactionType:
            WalletTransactionType.ASSURED_PASSENGER_CANCEL_DEPOSIT_DRIVER,
          referenceId: booking.id,
        },
      }),
    ).toBe(1);
    expect(
      await dataSource.getRepository(PassengerAssuredDepositPenalty).count({
        where: { userId: passenger.login.user.id },
      }),
    ).toBe(1);
  });

  it('driver cannot invoke passenger cancellation endpoint', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const ride = await publishAssuredRide(driver);
    const booking = await bookAssured(passenger, ride.id, 1);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(404);

    const row = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.id });
    expect(row.status).toBe(BookingStatus.CONFIRMED);
  });

  it('completed booking cannot receive passenger cancel compensation', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const ride = await publishAssuredRide(driver);
    const booking = await bookAssured(passenger, ride.id, 1);

    await dataSource
      .getRepository(Booking)
      .update({ id: booking.id }, { status: BookingStatus.COMPLETED });

    await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(409);
  });

  it('elevated 10% deposit after cancel resets to 5% after next Assured ride completes', async () => {
    const driver1 = await fundedDriver();
    const passenger = await fundedPassenger(20000n);
    const ride1 = await publishAssuredRide(driver1, {
      pricePerSeat: 500,
      source: 'Penalty Ride One',
      destination: 'Penalty Ride One Dest',
    });
    const booking1 = await bookAssured(passenger, ride1.id, 1);
    await request(app.getHttpServer())
      .post(`/bookings/${booking1.id}/cancel`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(me.body.assuredDepositPenalty).toMatchObject({
      percentage: 10,
      reason: 'PREVIOUS_ASSURED_CANCELLATION',
    });

    const booking2 = await bookAssured(passenger, ride1.id, 1);
    expect(booking2.securityDepositAmount).toBe('50');

    const booking2Row = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking2.id });
    expect(booking2Row.assuredDepositReason).toBe(
      'PREVIOUS_ASSURED_CANCELLATION',
    );

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver1.login.accessToken,
      ride1.id,
      pickupOtpPepper(),
    );
    await request(app.getHttpServer())
      .post(`/rides/${ride1.id}/complete`)
      .set('Authorization', `Bearer ${driver1.login.accessToken}`)
      .expect(200);

    const meAfter = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(meAfter.body.assuredDepositPenalty).toBeNull();

    const driver3 = await fundedDriver();
    const ride3 = await publishAssuredRide(driver3, {
      pricePerSeat: 500,
      source: 'Penalty Ride Three',
      destination: 'Penalty Ride Three Dest',
    });
    const booking3 = await bookAssured(passenger, ride3.id, 1);
    expect(booking3.securityDepositAmount).toBe('25');
  });

  it('passenger cancel rollback when wallet credit fails', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const ride = await publishAssuredRide(driver);
    const booking = await bookAssured(passenger, ride.id, 1);

    let depositCreditCalls = 0;
    const originalCredit = walletService.creditPointsInTransaction.bind(
      walletService,
    );
    const spy = jest
      .spyOn(walletService, 'creditPointsInTransaction')
      .mockImplementation(async (manager, input) => {
        if (
          input.transactionType ===
          WalletTransactionType.ASSURED_PASSENGER_CANCEL_DEPOSIT_DRIVER
        ) {
          depositCreditCalls += 1;
          throw new Error('simulated passenger cancel credit failure');
        }
        return originalCredit(manager, input);
      });

    await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(500);

    expect(depositCreditCalls).toBe(1);
    const row = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.id });
    expect(row.status).toBe(BookingStatus.CONFIRMED);
    expect(
      await dataSource.getRepository(PassengerAssuredDepositPenalty).count({
        where: { userId: passenger.login.user.id },
      }),
    ).toBe(0);

    spy.mockRestore();
  });

  it('driver no-show: before departure 409; after departure by passenger works once; same money as cancel', async () => {
    const futureDriver = await fundedDriver();
    const futurePassenger = await fundedPassenger();
    const futureRide = await publishAssuredRide(futureDriver);
    await bookAssured(futurePassenger, futureRide.id, 1);

    await request(app.getHttpServer())
      .post(`/rides/${futureRide.id}/driver-no-show`)
      .set('Authorization', `Bearer ${futurePassenger.login.accessToken}`)
      .expect(409);

    const driver = await fundedDriver();
    const passengerA = await fundedPassenger();
    const passengerB = await fundedPassenger();
    const ride = await publishAssuredRide(driver, {
      departureDate: PAST_DATE,
      departureTime: PAST_TIME,
      source: 'NoShow Source',
      destination: 'NoShow Dest',
    });
    await bookAssured(passengerA, ride.id, 1);
    await bookAssured(passengerB, ride.id, 1);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/driver-no-show`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(404);

    const [first, concurrent] = await Promise.all([
      request(app.getHttpServer())
        .post(`/rides/${ride.id}/driver-no-show`)
        .set('Authorization', `Bearer ${passengerA.login.accessToken}`),
      request(app.getHttpServer())
        .post(`/rides/${ride.id}/driver-no-show`)
        .set('Authorization', `Bearer ${passengerB.login.accessToken}`),
    ]);
    expect([first.status, concurrent.status].sort()).toEqual([200, 200]);
    const bodies = [first.body, concurrent.body];
    expect(bodies.every((b) => b.status === RideStatus.CANCELLED)).toBe(true);
    expect(bodies.some((b) => b.alreadyApplied === true)).toBe(true);
    expect(bodies.some((b) => b.alreadyApplied === false)).toBe(true);
    expect(bodies[0].driverDepositForfeited).toBe('100');
    expect(bodies[0].riderCompensationTotal).toBe('60');
    expect(bodies[0].platformForfeiture).toBe('40');

    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.cancellationReason).toBe(
      RideCancellationReason.DRIVER_NO_SHOW,
    );
    const driverHold = await dataSource
      .getRepository(WalletHold)
      .findOneByOrFail({ id: rideRow.driverDepositHoldId! });
    expect(driverHold.status).toBe(WalletHoldStatus.CONSUMED);
    expect(
      await dataSource.getRepository(AssuredLifecycleEvent).count({
        where: {
          rideId: ride.id,
          idempotencyKey: `assured:driver-no-show:${ride.id}`,
        },
      }),
    ).toBe(1);
  });

  it('rider no-show: by driver after departure; coupon issued once; deposit consumed; partial-fill', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const ride = await publishAssuredRide(driver, {
      departureDate: PAST_DATE,
      departureTime: PAST_TIME,
      source: 'RiderNoShow Source',
      destination: 'RiderNoShow Dest',
    });
    const booking = await bookAssured(passenger, ride.id, 1);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/rider-no-show`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(404);

    const reported = await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/rider-no-show`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    expect(reported.body).toMatchObject({
      bookingId: booking.id,
      status: BookingStatus.CANCELLED,
      cancellationReason: BookingCancellationReason.RIDER_NO_SHOW,
      seatsRestored: 1,
      partialFillCompensation: '250',
      couponIssued: true,
      alreadyApplied: false,
    });

    const bookingRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.id });
    const hold = await dataSource
      .getRepository(WalletHold)
      .findOneByOrFail({ id: bookingRow.walletHoldId! });
    expect(hold.status).toBe(WalletHoldStatus.CONSUMED);

    const coupons = await dataSource.getRepository(UserCoupon).find({
      where: {
        userId: passenger.login.user.id,
        couponType: UserCouponType.NEXT_ASSURED_DEPOSIT_FREE,
        sourceReferenceType: 'ASSURED_RIDER_NO_SHOW',
        sourceReferenceId: booking.id,
      },
    });
    expect(coupons).toHaveLength(1);
    expect(coupons[0].status).toBe(UserCouponStatus.UNUSED);

    const retry = await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/rider-no-show`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(retry.body.alreadyApplied).toBe(true);
    expect(retry.body.couponIssued).toBe(true);

    expect(
      await dataSource.getRepository(UserCoupon).count({
        where: {
          userId: passenger.login.user.id,
          sourceReferenceType: 'ASSURED_RIDER_NO_SHOW',
          sourceReferenceId: booking.id,
        },
      }),
    ).toBe(1);
  });

  it('coupon: unused → next Assured deposit 0; concurrent race; Regular cannot consume', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    await issueUnusedDepositCoupon(passenger.login.user.id);

    const ride = await publishAssuredRide(driver, {
      source: 'Coupon Source',
      destination: 'Coupon Dest',
    });
    const booking = await bookAssured(passenger, ride.id, 1);
    expect(booking.securityDepositAmount).toBe('0');
    expect(booking.totalAmount).toBe('500');
    expect(booking.bookingMode).toBe(BookingMode.ASSURED);

    const coupon = await dataSource.getRepository(UserCoupon).findOneByOrFail({
      usedBookingId: booking.id,
    });
    expect(coupon.status).toBe(UserCouponStatus.USED);

    const racePassenger = await fundedPassenger();
    await issueUnusedDepositCoupon(racePassenger.login.user.id);
    const rideA = await publishAssuredRide(driver, {
      source: 'Race A',
      destination: 'Race A Dest',
      departureTime: '11:00',
    });
    const rideB = await publishAssuredRide(driver, {
      source: 'Race B',
      destination: 'Race B Dest',
      departureTime: '12:00',
    });

    const [race1, race2] = await Promise.all([
      request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${racePassenger.login.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('race-a'))
        .send({
          rideId: rideA.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        }),
      request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${racePassenger.login.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('race-b'))
        .send({
          rideId: rideB.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        }),
    ]);
    expect(race1.status).toBe(201);
    expect(race2.status).toBe(201);
    const deposits = [
      race1.body.securityDepositAmount,
      race2.body.securityDepositAmount,
    ];
    expect(deposits.filter((d) => d === '0')).toHaveLength(1);
    expect(deposits.filter((d) => d === '25')).toHaveLength(1);
    expect(
      await dataSource.getRepository(UserCoupon).count({
        where: {
          userId: racePassenger.login.user.id,
          status: UserCouponStatus.USED,
        },
      }),
    ).toBe(1);

    const regularDriver = await fundedDriver();
    const regularPassenger = await fundedPassenger();
    const unused = await issueUnusedDepositCoupon(regularPassenger.login.user.id);
    const regularRide = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${regularDriver.login.accessToken}`)
      .send({
        rideType: RideType.REGULAR,
        vehicleId: regularDriver.vehicle.id,
        source: 'Regular Coupon Source',
        destination: 'Regular Coupon Dest',
        departureDate: FUTURE_DATE,
        departureTime: '13:00',
        totalSeats: 3,
        pricePerSeat: 200,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${regularPassenger.login.accessToken}`)
      .send({
        rideId: regularRide.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    const stillUnused = await dataSource
      .getRepository(UserCoupon)
      .findOneByOrFail({ id: unused.id });
    expect(stillUnused.status).toBe(UserCouponStatus.UNUSED);
  });

  it('partial-fill integration: rider no-show 1 empty seat capped at 700; insufficient platform funds fail safely', async () => {
    expect(calculatePartialFillCompensation(1, 2000n)).toBe(700n);

    const driver = await fundedDriver();
    const passenger = await fundedPassenger(500n);
    const ride = await publishAssuredRide(driver, {
      totalSeats: 2,
      pricePerSeat: 2000,
      departureDate: PAST_DATE,
      departureTime: PAST_TIME,
      source: 'Partial Cap Source',
      destination: 'Partial Cap Dest',
    });
    expect(ride.assuredDepositAmount).toBe('200');
    const booking = await bookAssured(passenger, ride.id, 1);
    expect(booking.securityDepositAmount).toBe('100');

    const capped = await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/rider-no-show`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(capped.body.partialFillCompensation).toBe('700');

    const driver2 = await fundedDriver();
    const passenger2 = await fundedPassenger();
    const ride2 = await publishAssuredRide(driver2, {
      departureDate: PAST_DATE,
      departureTime: '15:00',
      source: 'Partial Fail Source',
      destination: 'Partial Fail Dest',
    });
    const booking2 = await bookAssured(passenger2, ride2.id, 1);
    const holdBefore = await dataSource
      .getRepository(WalletHold)
      .findOneByOrFail({
        id: (
          await dataSource
            .getRepository(Booking)
            .findOneByOrFail({ id: booking2.id })
        ).walletHoldId!,
      });
    expect(holdBefore.status).toBe(WalletHoldStatus.ACTIVE);

    await withZeroedPlatformFunds(async () => {
      await request(app.getHttpServer())
        .post(`/bookings/${booking2.id}/rider-no-show`)
        .set('Authorization', `Bearer ${driver2.login.accessToken}`)
        .expect(422);
    });

    const bookingAfter = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking2.id });
    expect(bookingAfter.status).toBe(BookingStatus.CONFIRMED);
    const holdAfter = await dataSource
      .getRepository(WalletHold)
      .findOneByOrFail({ id: bookingAfter.walletHoldId! });
    expect(holdAfter.status).toBe(WalletHoldStatus.ACTIVE);
    expect(
      await dataSource.getRepository(AssuredLifecycleEvent).count({
        where: { bookingId: booking2.id },
      }),
    ).toBe(0);
  });

  it('half-time: gate, ALLOW Regular PAY_LATER, KEEP default, lock after Regular, Assured still pays deposit', async () => {
    const driver = await fundedDriver();
    const assuredPassenger = await fundedPassenger();
    const regularPassenger = await fundedPassenger();

    const earlyRide = await publishAssuredRide(driver, {
      departureDate: tomorrowDate(),
      departureTime: '18:00',
      source: 'Half Early',
      destination: 'Half Early Dest',
    });
    await request(app.getHttpServer())
      .post(`/rides/${earlyRide.id}/half-time-decision`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ policy: RegularSeatsPolicy.ALLOW_REGULAR_RIDERS })
      .expect(409);

    const ride = await publishAssuredRide(driver, {
      departureDate: tomorrowDate(),
      departureTime: '19:00',
      source: 'Half Allow',
      destination: 'Half Allow Dest',
    });
    await pushCreatedAtPastHalfTime(ride.id);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${regularPassenger.login.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(409);

    const allow = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/half-time-decision`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ policy: RegularSeatsPolicy.ALLOW_REGULAR_RIDERS })
      .expect(200);
    expect(allow.body).toMatchObject({
      rideId: ride.id,
      policy: RegularSeatsPolicy.ALLOW_REGULAR_RIDERS,
      alreadyApplied: false,
    });

    const regularBooking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${regularPassenger.login.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);
    expect(regularBooking.body.bookingMode).toBe(BookingMode.REGULAR);
    expect(regularBooking.body.securityDepositAmount).toBeNull();

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/half-time-decision`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ policy: RegularSeatsPolicy.KEEP_ASSURED_ONLY })
      .expect(409);

    const assuredBooking = await bookAssured(assuredPassenger, ride.id, 1);
    expect(assuredBooking.securityDepositAmount).toBe('25');
    expect(assuredBooking.bookingMode).toBe(BookingMode.ASSURED);

    const keepDriver = await fundedDriver();
    const keepPassenger = await fundedPassenger();
    const keepRide = await publishAssuredRide(keepDriver, {
      departureDate: tomorrowDate(),
      departureTime: '20:00',
      source: 'Keep Default',
      destination: 'Keep Default Dest',
    });
    const keepBooking = await bookAssured(keepPassenger, keepRide.id, 1);
    const keepCancel = await request(app.getHttpServer())
      .post(`/bookings/${keepBooking.id}/cancel`)
      .set('Authorization', `Bearer ${keepPassenger.login.accessToken}`)
      .expect(200);
    expect(keepCancel.body).toMatchObject({
      partialFillCompensation: null,
      driverCompensation: '25',
      platformAmount: '0',
      nextAssuredDepositPercentage: 10,
    });
    const keepRideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: keepRide.id });
    expect(keepRideRow.regularSeatsPolicy).toBeNull();
  });

  it('completion regression: releases ACTIVE deposits; cancel/complete mutual exclusion; CONSUMED not released', async () => {
    const driver = await fundedDriver();
    const passengerA = await fundedPassenger();
    const passengerB = await fundedPassenger();
    const ride = await publishAssuredRide(driver, {
      source: 'Complete Reg Source',
      destination: 'Complete Reg Dest',
    });
    const bookingA = await bookAssured(passengerA, ride.id, 1);
    const bookingB = await bookAssured(passengerB, ride.id, 1);

    await request(app.getHttpServer())
      .post(`/bookings/${bookingA.id}/cancel`)
      .set('Authorization', `Bearer ${passengerA.login.accessToken}`)
      .expect(200);

    const consumedHold = await dataSource
      .getRepository(WalletHold)
      .findOneByOrFail({
        id: (
          await dataSource
            .getRepository(Booking)
            .findOneByOrFail({ id: bookingA.id })
        ).walletHoldId!,
      });
    expect(consumedHold.status).toBe(WalletHoldStatus.CONSUMED);

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
    expect(completed.body.releasedDeposits.driver).toBe('100');
    expect(completed.body.releasedDeposits.riders).toBe('25');
    expect(completed.body.releasedDeposits.riderCount).toBe(1);

    const activeHold = await dataSource
      .getRepository(WalletHold)
      .findOneByOrFail({
        id: (
          await dataSource
            .getRepository(Booking)
            .findOneByOrFail({ id: bookingB.id })
        ).walletHoldId!,
      });
    expect(activeHold.status).toBe(WalletHoldStatus.RELEASED);

    const stillConsumed = await dataSource
      .getRepository(WalletHold)
      .findOneByOrFail({ id: consumedHold.id });
    expect(stillConsumed.status).toBe(WalletHoldStatus.CONSUMED);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(409);

    const cancelDriver = await fundedDriver();
    const cancelRide = await publishAssuredRide(cancelDriver, {
      source: 'Cancel Then Complete',
      destination: 'Cancel Then Complete Dest',
    });
    await request(app.getHttpServer())
      .post(`/rides/${cancelRide.id}/cancel`)
      .set('Authorization', `Bearer ${cancelDriver.login.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/rides/${cancelRide.id}/complete`)
      .set('Authorization', `Bearer ${cancelDriver.login.accessToken}`)
      .expect(409);
  });

  it('security: no client-supplied amounts; IDOR returns 404', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const other = await fundedPassenger();
    const outsider = await fundedPassenger();
    const ride = await publishAssuredRide(driver, {
      departureDate: tomorrowDate(),
      departureTime: '21:00',
      source: 'Security Source',
      destination: 'Security Dest',
    });
    await bookAssured(passenger, ride.id, 1);
    await bookAssured(other, ride.id, 1);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${outsider.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('sec-amt'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        depositAmount: '1',
        assuredDepositPercentage: 99,
      })
      .expect(400);

    await pushCreatedAtPastHalfTime(ride.id);
    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/half-time-decision`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        policy: RegularSeatsPolicy.KEEP_ASSURED_ONLY,
        halfTime: '2099-01-01T00:00:00.000Z',
        amount: '999',
      })
      .expect(400);

    const cancel = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        driverDepositForfeited: '1',
        riderCompensationTotal: '999',
        platformForfeiture: '0',
      })
      .expect(200);
    expect(cancel.body.driverDepositForfeited).toBe('100');
    expect(cancel.body.riderCompensationTotal).toBe('60');
    expect(cancel.body.platformForfeiture).toBe('40');

    const fakeId = '00000000-0000-4000-8000-000000009999';
    await request(app.getHttpServer())
      .post(`/rides/${fakeId}/cancel`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/bookings/${fakeId}/cancel`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(404);

    const idorDriver = await fundedDriver();
    const idorPassenger = await fundedPassenger();
    const idorOther = await fundedPassenger();
    const idorRide = await publishAssuredRide(idorDriver, {
      source: 'IDOR Source',
      destination: 'IDOR Dest',
    });
    const idorBooking = await bookAssured(idorPassenger, idorRide.id, 1);
    await request(app.getHttpServer())
      .post(`/bookings/${idorBooking.id}/cancel`)
      .set('Authorization', `Bearer ${idorOther.login.accessToken}`)
      .expect(404);
  });

  describe('Phase 1 driver cancellation (fare refund, coupons, settlement)', () => {
    it('refunds PAY_NOW fare separately from deposit release and compensation', async () => {
      const driver = await fundedDriver();
      const payNowPassenger = await fundedPassenger(5000n);
      const payLaterPassenger = await fundedPassenger(5000n);
      const ride = await publishAssuredRide(driver);

      const payNowBooking = await bookAssured(payNowPassenger, ride.id, 1, {
        farePayment: BookingFarePayment.PAY_NOW,
      });
      const payLaterBooking = await bookAssured(
        payLaterPassenger,
        ride.id,
        1,
        { farePayment: BookingFarePayment.PAY_LATER },
      );
      expect(payNowBooking.totalAmount).toBe('500');
      expect(payNowBooking.farePaymentStatus).toBe(BookingPaymentStatus.PAID);
      expect(payLaterBooking.farePaymentStatus).toBe(
        BookingPaymentStatus.UNPAID,
      );

      const payNowBalanceBefore = await dataSource
        .getRepository(WalletBalance)
        .findOneByOrFail({ walletId: payNowPassenger.wallet.id });

      const cancelled = await request(app.getHttpServer())
        .post(`/rides/${ride.id}/cancel`)
        .set('Authorization', `Bearer ${driver.login.accessToken}`)
        .expect(200);

      expect(cancelled.body).toMatchObject({
        fareRefundedTotal: '500',
        couponsIssuedCount: 2,
        riderCompensationTotal: '60',
        platformForfeiture: '40',
      });

      const payNowHoldRelease = await dataSource
        .getRepository(WalletTransaction)
        .findOne({
          where: {
            walletId: payNowPassenger.wallet.id,
            transactionType: WalletTransactionType.HOLD_RELEASE,
          },
        });
      const payNowComp = await dataSource
        .getRepository(WalletTransaction)
        .findOne({
          where: {
            walletId: payNowPassenger.wallet.id,
            transactionType: WalletTransactionType.ASSURED_RIDER_COMPENSATION,
          },
        });
      const payNowFareRefund = await dataSource
        .getRepository(WalletTransaction)
        .findOne({
          where: {
            walletId: payNowPassenger.wallet.id,
            transactionType: WalletTransactionType.REFUND,
          },
        });

      expect(payNowHoldRelease?.amount).toBe('25');
      expect(payNowComp?.amount).toBe('30');
      expect(payNowFareRefund?.amount).toBe('500');
      expect(payNowHoldRelease?.id).not.toBe(payNowComp?.id);
      expect(payNowHoldRelease?.id).not.toBe(payNowFareRefund?.id);
      expect(payNowComp?.id).not.toBe(payNowFareRefund?.id);

      const payLaterRefund = await dataSource
        .getRepository(WalletTransaction)
        .count({
          where: {
            walletId: payLaterPassenger.wallet.id,
            transactionType: WalletTransactionType.REFUND,
          },
        });
      expect(payLaterRefund).toBe(0);

      const payNowBalanceAfter = await dataSource
        .getRepository(WalletBalance)
        .findOneByOrFail({ walletId: payNowPassenger.wallet.id });
      expect(
        BigInt(payNowBalanceAfter.purchasedAvailable) -
          BigInt(payNowBalanceBefore.purchasedAvailable),
      ).toBe(25n + 30n + 500n);

      const payNowCoupon = await dataSource
        .getRepository(UserCoupon)
        .findOneByOrFail({
          userId: payNowPassenger.login.user.id,
          sourceReferenceType: 'ASSURED_DRIVER_CANCEL',
          sourceReferenceId: payNowBooking.id,
        });
      expect(payNowCoupon.couponType).toBe(
        UserCouponType.NEXT_ASSURED_DEPOSIT_FREE,
      );
      expect(payNowCoupon.status).toBe(UserCouponStatus.UNUSED);

      const payLaterCoupon = await dataSource
        .getRepository(UserCoupon)
        .findOneByOrFail({
          userId: payLaterPassenger.login.user.id,
          sourceReferenceType: 'ASSURED_DRIVER_CANCEL',
          sourceReferenceId: payLaterBooking.id,
        });
      expect(payLaterCoupon.status).toBe(UserCouponStatus.UNUSED);

      const payNowRow = await dataSource
        .getRepository(Booking)
        .findOneByOrFail({ id: payNowBooking.id });
      expect(payNowRow.paymentStatus).toBe(BookingPaymentStatus.PAID);
      expect(payNowRow.fareWalletTransactionId).not.toBeNull();
      expect(payNowRow.totalAmount).toBe('500');
      expect(payNowRow.assuredDepositAmount).toBe('25');
    });

    it('splits compensation evenly among three passengers with remainder to first', async () => {
      const driver = await fundedDriver();
      const passengers = await Promise.all([
        fundedPassenger(),
        fundedPassenger(),
        fundedPassenger(),
      ]);
      const ride = await publishAssuredRide(driver);

      for (const passenger of passengers) {
        await bookAssured(passenger, ride.id, 1);
      }

      const cancelled = await request(app.getHttpServer())
        .post(`/rides/${ride.id}/cancel`)
        .set('Authorization', `Bearer ${driver.login.accessToken}`)
        .expect(200);

      expect(cancelled.body).toMatchObject({
        driverDepositForfeited: '100',
        riderCompensationTotal: '60',
        platformForfeiture: '40',
        couponsIssuedCount: 3,
      });

      const comps = await dataSource.getRepository(WalletTransaction).find({
        where: {
          transactionType: WalletTransactionType.ASSURED_RIDER_COMPENSATION,
          referenceId: ride.id,
        },
        order: { createdAt: 'ASC' },
      });
      expect(comps).toHaveLength(3);
      expect(comps.map((tx) => tx.amount).sort()).toEqual(['20', '20', '20']);
    });

    it('idempotent retry does not double-refund fare, compensate, or issue coupons', async () => {
      const driver = await fundedDriver();
      const passenger = await fundedPassenger(5000n);
      const ride = await publishAssuredRide(driver);
      await bookAssured(passenger, ride.id, 1, {
        farePayment: BookingFarePayment.PAY_NOW,
      });

      await request(app.getHttpServer())
        .post(`/rides/${ride.id}/cancel`)
        .set('Authorization', `Bearer ${driver.login.accessToken}`)
        .expect(200);

      const retry = await request(app.getHttpServer())
        .post(`/rides/${ride.id}/cancel`)
        .set('Authorization', `Bearer ${driver.login.accessToken}`)
        .expect(200);
      expect(retry.body.alreadyApplied).toBe(true);

      expect(
        await dataSource.getRepository(WalletTransaction).count({
          where: {
            walletId: passenger.wallet.id,
            transactionType: WalletTransactionType.REFUND,
          },
        }),
      ).toBe(1);
      expect(
        await dataSource.getRepository(WalletTransaction).count({
          where: {
            walletId: passenger.wallet.id,
            transactionType: WalletTransactionType.ASSURED_RIDER_COMPENSATION,
          },
        }),
      ).toBe(1);
      expect(
        await dataSource.getRepository(UserCoupon).count({
          where: {
            userId: passenger.login.user.id,
            sourceReferenceType: 'ASSURED_DRIVER_CANCEL',
          },
        }),
      ).toBe(1);
      expect(
        await dataSource.getRepository(WalletTransaction).count({
          where: {
            walletId: PLATFORM_WALLET_ID,
            transactionType: WalletTransactionType.ASSURED_PLATFORM_FORFEITURE,
            referenceId: ride.id,
          },
        }),
      ).toBe(1);
    });

    it('driver no-show does not refund PAY_NOW fare or issue driver-cancel coupons', async () => {
      const driver = await fundedDriver();
      const passenger = await fundedPassenger(5000n);
      const ride = await publishAssuredRide(driver, {
        departureDate: PAST_DATE,
        departureTime: PAST_TIME,
        source: 'NoShow Fare Source',
        destination: 'NoShow Fare Dest',
      });
      await bookAssured(passenger, ride.id, 1, {
        farePayment: BookingFarePayment.PAY_NOW,
      });

      await request(app.getHttpServer())
        .post(`/rides/${ride.id}/driver-no-show`)
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .expect(200);

      expect(
        await dataSource.getRepository(WalletTransaction).count({
          where: {
            walletId: passenger.wallet.id,
            transactionType: WalletTransactionType.REFUND,
          },
        }),
      ).toBe(0);
      expect(
        await dataSource.getRepository(UserCoupon).count({
          where: {
            userId: passenger.login.user.id,
            sourceReferenceType: 'ASSURED_DRIVER_CANCEL',
          },
        }),
      ).toBe(0);
    });

    it('rolls back when a downstream fare refund fails', async () => {
      const driver = await fundedDriver();
      const passengerA = await fundedPassenger(5000n);
      const passengerB = await fundedPassenger(5000n);
      const ride = await publishAssuredRide(driver);
      await bookAssured(passengerA, ride.id, 1, {
        farePayment: BookingFarePayment.PAY_NOW,
      });
      await bookAssured(passengerB, ride.id, 1, {
        farePayment: BookingFarePayment.PAY_NOW,
      });

      const bookingB = await dataSource.getRepository(Booking).findOneByOrFail({
        rideId: ride.id,
        passengerId: passengerB.login.user.id,
      });

      let refundCalls = 0;
      const originalCredit = walletService.creditPointsInTransaction.bind(
        walletService,
      );
      const spy = jest
        .spyOn(walletService, 'creditPointsInTransaction')
        .mockImplementation(async (manager, input) => {
          if (
            input.transactionType === WalletTransactionType.REFUND &&
            input.referenceId === bookingB.id
          ) {
            refundCalls += 1;
            throw new Error('simulated fare refund failure');
          }
          return originalCredit(manager, input);
        });

      await request(app.getHttpServer())
        .post(`/rides/${ride.id}/cancel`)
        .set('Authorization', `Bearer ${driver.login.accessToken}`)
        .expect(500);

      expect(refundCalls).toBe(1);

      const rideRow = await dataSource
        .getRepository(Ride)
        .findOneByOrFail({ id: ride.id });
      expect(rideRow.status).toBe(RideStatus.ASSURANCE_ACTIVE);

      expect(
        await dataSource.getRepository(WalletTransaction).count({
          where: {
            walletId: passengerA.wallet.id,
            transactionType: WalletTransactionType.REFUND,
          },
        }),
      ).toBe(0);
      expect(
        await dataSource.getRepository(UserCoupon).count({
          where: { sourceReferenceType: 'ASSURED_DRIVER_CANCEL' },
        }),
      ).toBe(0);

      spy.mockRestore();
    });
  });
});

describe('calculateAssuredHalfTime (unit)', () => {
  it('returns midpoint between createdAt and civil departure', () => {
    const createdAt = new Date('2099-01-01T10:00:00');
    const half = calculateAssuredHalfTime(createdAt, '2099-01-03', '10:00');
    const departure = new Date('2099-01-03T10:00:00');
    expect(half.getTime()).toBe(
      createdAt.getTime() +
        Math.floor((departure.getTime() - createdAt.getTime()) / 2),
    );
  });

  it('clamps to createdAt when departure is earlier', () => {
    const createdAt = new Date('2099-06-15T12:00:00');
    const half = calculateAssuredHalfTime(createdAt, '2099-06-14', '10:00');
    expect(half.getTime()).toBe(createdAt.getTime());
  });
});
