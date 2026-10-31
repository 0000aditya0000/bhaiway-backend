/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource, In } from 'typeorm';

import { AdminModule } from '../admin.module';
import {
  ADMIN_PERMISSION_DASHBOARD_VIEW,
  ADMIN_PERMISSION_RIDES_MANAGE,
  ADMIN_PERMISSION_RIDES_VIEW,
} from '../admin.constants';
import { AdminRideCancellation } from '../entities/admin-ride-cancellation.entity';
import { AdminUser } from '../entities/admin-user.entity';
import { AuthModule } from '../../auth/auth.module';
import { AuthService } from '../../auth/auth.service';
import { Msg91ResponseFormatError } from '../../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../../auth/providers/otp-provider.interface';
import { BookingsModule } from '../../bookings/bookings.module';
import { Booking } from '../../bookings/entities/booking.entity';
import {
  BookingFarePayment,
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingPickupStatus,
  BookingStatus,
} from '../../bookings/enums/booking.enums';
import { deleteChatForBookingIds } from '../../chat/test/chat-test.helpers';
import { Notification } from '../../notifications/entities/notification.entity';
import { NotificationType } from '../../notifications/enums/notification.enums';
import { AssuredLifecycleEvent } from '../../assured/entities/assured-lifecycle-event.entity';
import { RidesModule } from '../../rides/rides.module';
import { RideSeries } from '../../rides/entities/ride-series.entity';
import { Ride } from '../../rides/entities/ride.entity';
import {
  RideCancellationReason,
  RideStatus,
  RideType,
  SeriesScope,
} from '../../rides/enums/ride.enums';
import { futureCivilDate } from '../../rides/test/ride-departure-test.helpers';
import { startRideAndVerifyAllPickups } from '../../rides/test/ride-trip-test.helpers';
import {
  ASSURED_TEST_ROUTE,
  withAssuredPublishHeaders,
} from '../../rides/test/assured-ride-test.helpers';
import { withSelectedRoute } from '../../rides/test/selected-route-test.helpers';
import { SettingsModule } from '../../settings/settings.module';
import { SettingsService } from '../../settings/settings.service';
import { UserProfile } from '../../users/entities/user-profile.entity';
import { markVerificationVerified } from '../../verification/test/verification-test.helpers';
import { UserVerification } from '../../verification/entities/user-verification.entity';
import { VerificationModule } from '../../verification/verification.module';
import { VerificationService } from '../../verification/verification.service';
import { VerificationType } from '../../verification/enums/verification.enums';
import { Vehicle } from '../../vehicles/entities/vehicle.entity';
import { VehicleType } from '../../vehicles/enums/vehicle-type.enum';
import { VehiclesModule } from '../../vehicles/vehicles.module';
import { VehiclesService } from '../../vehicles/vehicles.service';
import { WalletBalance } from '../../wallet/entities/wallet-balance.entity';
import {
  WalletHold,
  WalletHoldStatus,
} from '../../wallet/entities/wallet-hold.entity';
import { WalletPointSource } from '../../wallet/entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionType,
} from '../../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../../wallet/entities/wallet.entity';
import { WalletModule } from '../../wallet/wallet.module';
import { WalletService } from '../../wallet/wallet.service';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../../wallet/test/wallet-test.helpers';
import {
  REDIS_CLIENT,
  RIDE_TRACKING_STALE_AFTER_MS,
  rideTrackingKey,
} from '../../tracking/tracking.constants';
import {
  ADMIN_OPS_DRIVER_CANCEL_BODY,
  ADMIN_OPS_PASSENGER_CANCEL_BODY,
} from './admin-ride.constants';

function pickupOtpPepper(): string {
  const secret = process.env.JWT_ACCESS_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new Error('JWT_ACCESS_SECRET is required for pickup OTP tests');
  }
  return secret;
}

describe('Admin ride management (integration)', () => {
  jest.setTimeout(90_000);

  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  let settingsService: SettingsService;
  let redis: Redis | null = null;
  const tracked: TestWalletContext[] = [];
  let originalPercentage: number;

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
        AdminModule,
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
    try {
      redis = moduleRef.get<Redis>(REDIS_CLIENT);
    } catch {
      redis = null;
    }

    await dataSource.query(`
      ALTER TYPE "public"."rides_cancellation_reason_enum"
      ADD VALUE IF NOT EXISTS 'ADMIN_CANCELLED'
    `);
    await dataSource.query(`
      ALTER TYPE "public"."bookings_cancellation_reason_enum"
      ADD VALUE IF NOT EXISTS 'ADMIN_CANCELLED'
    `);
    await dataSource.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'ADMIN_RIDE_CANCELLED'
    `);
    await dataSource.query(`
      ALTER TYPE "public"."assured_queue_events_advance_reason_enum"
      ADD VALUE IF NOT EXISTS 'ADMIN_CANCELLED'
    `);
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS "admin_ride_cancellations" (
        "id" uuid NOT NULL,
        "admin_user_id" uuid NOT NULL,
        "admin_actor_user_id" uuid NOT NULL,
        "ride_id" uuid NOT NULL,
        "ride_type" character varying(32) NOT NULL,
        "previous_status" character varying(32) NOT NULL,
        "final_status" character varying(32) NOT NULL,
        "reason" character varying(500) NOT NULL,
        "series_scope" character varying(32),
        "support_escalation_required" boolean NOT NULL DEFAULT false,
        "refund_total" bigint NOT NULL DEFAULT 0,
        "deposit_release_total" bigint NOT NULL DEFAULT 0,
        "compensation_total" bigint NOT NULL DEFAULT 0,
        "already_applied" boolean NOT NULL DEFAULT false,
        "bookings" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "financial_transaction_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "idempotency_key" character varying(255) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_admin_ride_cancellations_test" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_admin_ride_cancellations_test_idempotency_key" UNIQUE ("idempotency_key")
      )
    `);
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (!ctx) {
        continue;
      }
      const driverRides = await dataSource.getRepository(Ride).find({
        where: { driverId: ctx.userId },
      });
      const passengerBookings = await dataSource.getRepository(Booking).find({
        where: { passengerId: ctx.userId },
      });
      const rideIds = [
        ...new Set([
          ...driverRides.map((ride) => ride.id),
          ...passengerBookings.map((booking) => booking.rideId),
        ]),
      ];
      const bookingIds = [
        ...new Set([
          ...(
            await dataSource.getRepository(Booking).find({
              where:
                rideIds.length > 0
                  ? { rideId: In(rideIds) }
                  : { passengerId: ctx.userId },
              select: { id: true },
            })
          ).map((row) => row.id),
        ]),
      ];
      if (rideIds.length > 0) {
        await dataSource.getRepository(AdminRideCancellation).delete({
          rideId: In(rideIds),
        });
        await dataSource.query(
          `DELETE FROM gst_invoices WHERE ride_id = ANY($1::uuid[])`,
          [rideIds],
        );
        await dataSource.query(
          `DELETE FROM no_show_claims WHERE ride_id = ANY($1::uuid[])`,
          [rideIds],
        );
        await dataSource.getRepository(AssuredLifecycleEvent).delete({
          rideId: In(rideIds),
        });
      }
      if (bookingIds.length > 0) {
        await dataSource.query(
          `DELETE FROM rating_tasks WHERE booking_id = ANY($1::uuid[])`,
          [bookingIds],
        );
        await deleteChatForBookingIds(dataSource, bookingIds);
        await dataSource.getRepository(Booking).delete({ id: In(bookingIds) });
      }
      if (rideIds.length > 0) {
        await dataSource.getRepository(Ride).delete({ id: In(rideIds) });
      }
      await dataSource
        .getRepository(RideSeries)
        .delete({ driverId: ctx.userId });
      await dataSource.getRepository(Vehicle).delete({ userId: ctx.userId });
      await dataSource.getRepository(UserVerification).delete({
        userId: ctx.userId,
      });
      await dataSource.query(
        `DELETE FROM notification_email_deliveries
         WHERE notification_id IN (
           SELECT id FROM notifications WHERE recipient_user_id = $1
         )`,
        [ctx.userId],
      );
      await dataSource
        .getRepository(Notification)
        .delete({ recipientUserId: ctx.userId });
      await dataSource.getRepository(AdminUser).delete({ userId: ctx.userId });
      await cleanupTestWallet(dataSource, ctx).catch(() => undefined);
    }
  });

  afterAll(async () => {
    if (settingsService && originalPercentage != null) {
      await settingsService.setAssuredRideDepositPercentage(originalPercentage);
    }
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

  async function createAdmin(permissions: string[]) {
    const { login, wallet } = await createAuthenticatedUser();
    await dataSource.getRepository(AdminUser).save(
      dataSource.getRepository(AdminUser).create({
        userId: login.user.id,
        username: `rides_${login.user.id.slice(0, 8)}`,
        passwordHash: 'x',
        permissions,
        isActive: true,
      }),
    );
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

  async function publishableDriver(
    rideType: RideType = RideType.REGULAR,
    totalSeats = 3,
    pricePerSeat = 250,
  ) {
    const { login, wallet } = await createAuthenticatedUser();
    await dataSource.getRepository(UserProfile).save(
      dataSource.getRepository(UserProfile).create({
        userId: login.user.id,
        firstName: 'Admin',
        lastName: 'Driver',
        displayName: `Driver ${login.user.id.slice(0, 6)}`,
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example.com/driver.jpg',
      }),
    );
    const vehicle = await vehiclesService.create(login.user.id, {
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
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
    await markVerified(login.user.id, VerificationType.VEHICLE);
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: 20000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('admin-driver-fund'),
    });

    const req = request(app.getHttpServer()).post('/rides');
    if (rideType === RideType.ASSURED) {
      req.set(withAssuredPublishHeaders(login.accessToken));
    } else {
      req.set('Authorization', `Bearer ${login.accessToken}`);
      if (rideType === RideType.COMMUTE) {
        req.set('Idempotency-Key', uniqueIdempotencyKey('admin-commute'));
      }
    }
    const body =
      rideType === RideType.ASSURED
        ? withSelectedRoute({
            rideType,
            vehicleId: vehicle.id,
            source: 'Noida Sector 62',
            destination: 'Connaught Place',
            departureDate: '2099-06-15',
            departureTime: '10:00',
            totalSeats,
            pricePerSeat,
            ...ASSURED_TEST_ROUTE,
          })
        : withSelectedRoute({
            rideType,
            vehicleId: vehicle.id,
            source: 'Noida Sector 62',
            destination: 'Connaught Place',
            departureDate: futureCivilDate(14),
            departureTime: '09:00',
            totalSeats,
            pricePerSeat,
            ...(rideType === RideType.COMMUTE ? { recurring: true } : {}),
          });
    const rideResponse = await req.send(body).expect(201);
    return { login, wallet, vehicle, ride: rideResponse.body };
  }

  async function fundedPassenger(creditAmount = 5000n) {
    const { login, wallet } = await createAuthenticatedUser();
    await dataSource.getRepository(UserProfile).save(
      dataSource.getRepository(UserProfile).create({
        userId: login.user.id,
        firstName: 'Admin',
        lastName: 'Passenger',
        displayName: `Passenger ${login.user.id.slice(0, 6)}`,
        gender: null,
        dateOfBirth: null,
        profilePhoto: null,
      }),
    );
    await markVerified(login.user.id, VerificationType.IDENTITY);
    if (creditAmount > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: creditAmount,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('admin-pass-fund'),
      });
    }
    return { login, wallet };
  }

  async function bookRide(
    passengerToken: string,
    rideId: string,
    paymentMethod: BookingPaymentMethod,
    seats = 1,
    extra: Record<string, unknown> = {},
  ) {
    const req = request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passengerToken}`)
      .send({ rideId, seats, paymentMethod, ...extra });
    if (paymentMethod !== BookingPaymentMethod.PAY_LATER) {
      req.set('Idempotency-Key', uniqueIdempotencyKey('admin-book'));
    }
    return req.expect(201);
  }

  it('rejects unauthenticated and under-permissioned admin ride access', async () => {
    await request(app.getHttpServer()).get('/admin/rides').expect(401);
    const { login } = await createAdmin([ADMIN_PERMISSION_DASHBOARD_VIEW]);
    await request(app.getHttpServer())
      .get('/admin/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .post('/admin/rides/00000000-0000-4000-8000-000000000001/cancel')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ reason: 'Ops cancellation' })
      .expect(403);
  });

  it('lists rides with filters, pagination, masked phones and commute pending seats', async () => {
    const admin = await createAdmin([ADMIN_PERMISSION_RIDES_VIEW]);
    const regular = await publishableDriver(RideType.REGULAR, 3, 250);
    const commute = await publishableDriver(RideType.COMMUTE, 3, 100);
    const passenger = await fundedPassenger();
    await bookRide(
      passenger.login.accessToken,
      commute.ride.id,
      BookingPaymentMethod.PAY_NOW,
    );

    const listed = await request(app.getHttpServer())
      .get('/admin/rides')
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .query({ search: regular.ride.id })
      .expect(200);
    expect(
      listed.body.items.some(
        (row: { id: string }) => row.id === regular.ride.id,
      ),
    ).toBe(true);
    const sample = listed.body.items.find(
      (row: { id: string }) => row.id === regular.ride.id,
    );
    expect(sample.driver.phoneMasked).toBeTruthy();
    expect(sample.driver.phoneMasked).not.toBe(regular.login.user.phone);
    expect(JSON.stringify(listed.body)).not.toContain(regular.login.user.phone);

    const commuteList = await request(app.getHttpServer())
      .get('/admin/rides')
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .query({ search: commute.ride.id })
      .expect(200);
    expect(commuteList.body.items).toHaveLength(1);
    expect(commuteList.body.items[0].bookedSeats).toBe(0);

    const paged = await request(app.getHttpServer())
      .get('/admin/rides')
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .query({ page: 1, limit: 1 })
      .expect(200);
    expect(paged.body.limit).toBe(1);
    expect(paged.body.items).toHaveLength(1);
  });

  it('returns complete operational detail for a Regular ride', async () => {
    const admin = await createAdmin([ADMIN_PERMISSION_RIDES_VIEW]);
    const { ride } = await publishableDriver();
    const passenger = await fundedPassenger();
    await bookRide(
      passenger.login.accessToken,
      ride.id,
      BookingPaymentMethod.PAY_LATER,
    );

    const detail = await request(app.getHttpServer())
      .get(`/admin/rides/${ride.id}`)
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .expect(200);
    expect(detail.body.ride.id).toBe(ride.id);
    expect(detail.body.driver.phone).toBeTruthy();
    expect(detail.body.passengers).toHaveLength(1);
    expect(detail.body.passengers[0].pickupDropCoordinates).toBeNull();
    expect(detail.body.financials.payments).toHaveLength(1);
    expect(detail.body.location.status).toBe('NOT_IN_PROGRESS');
    expect(detail.body.history.currentStatus).toBe(RideStatus.PUBLISHED);
  });

  it('reports missing GPS for an in-progress ride', async () => {
    const admin = await createAdmin([ADMIN_PERMISSION_RIDES_VIEW]);
    const { login, ride } = await publishableDriver();
    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);
    const detail = await request(app.getHttpServer())
      .get(`/admin/rides/${ride.id}`)
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .expect(200);
    expect(detail.body.location.status).toBe('MISSING');
  });

  it('reports available and stale GPS from Redis', async () => {
    if (!redis || String(redis.status) !== 'ready') {
      return;
    }
    const admin = await createAdmin([ADMIN_PERMISSION_RIDES_VIEW]);
    const { login, ride } = await publishableDriver();
    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);
    const key = rideTrackingKey(ride.id);
    await redis.set(
      key,
      JSON.stringify({
        rideId: ride.id,
        driverId: login.user.id,
        latitude: 28.61,
        longitude: 77.2,
        timestamp: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        heading: 90,
        speed: 12,
      }),
    );
    const live = await request(app.getHttpServer())
      .get(`/admin/rides/${ride.id}`)
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .expect(200);
    expect(live.body.location.status).toBe('AVAILABLE');
    expect(live.body.location.latitude).toBe(28.61);

    await redis.set(
      key,
      JSON.stringify({
        rideId: ride.id,
        driverId: login.user.id,
        latitude: 28.61,
        longitude: 77.2,
        timestamp: new Date(
          Date.now() - RIDE_TRACKING_STALE_AFTER_MS - 5_000,
        ).toISOString(),
        updatedAt: new Date(
          Date.now() - RIDE_TRACKING_STALE_AFTER_MS - 5_000,
        ).toISOString(),
      }),
    );
    const stale = await request(app.getHttpServer())
      .get(`/admin/rides/${ride.id}`)
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .expect(200);
    expect(stale.body.location.status).toBe('STALE');
    await redis.del(key);
  });

  it('refunds Regular PAY_NOW collected amount and skips PAY_LATER', async () => {
    const admin = await createAdmin([
      ADMIN_PERMISSION_RIDES_VIEW,
      ADMIN_PERMISSION_RIDES_MANAGE,
    ]);
    const { ride } = await publishableDriver(RideType.REGULAR, 4, 250);
    const payNow = await fundedPassenger(1000n);
    const payLater = await fundedPassenger(1000n);
    const nowBooking = await bookRide(
      payNow.login.accessToken,
      ride.id,
      BookingPaymentMethod.PAY_NOW,
    );
    const laterBooking = await bookRide(
      payLater.login.accessToken,
      ride.id,
      BookingPaymentMethod.PAY_LATER,
    );

    const cancel = await request(app.getHttpServer())
      .post(`/admin/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .send({ reason: 'Ops pre-trip cancellation' })
      .expect(200);
    expect(cancel.body.finalStatus).toBe(RideStatus.CANCELLED);
    expect(cancel.body.refundTotal).toBe('250');
    expect(cancel.body.compensationTotal).toBe('0');
    expect(cancel.body.supportEscalationRequired).toBe(false);
    expect(cancel.body.alreadyApplied).toBe(false);

    const paid = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: nowBooking.body.id });
    expect(paid.status).toBe(BookingStatus.CANCELLED);
    expect(paid.paymentStatus).toBe(BookingPaymentStatus.REFUNDED);
    const unpaid = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: laterBooking.body.id });
    expect(unpaid.status).toBe(BookingStatus.CANCELLED);
    expect(unpaid.paymentStatus).toBe(BookingPaymentStatus.UNPAID);

    const refunds = await dataSource.getRepository(WalletTransaction).find({
      where: {
        userId: payNow.login.user.id,
        transactionType: WalletTransactionType.REFUND,
      },
    });
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount).toBe('250');
    expect(refunds[0].parentTransactionId).toBeTruthy();
    const laterRefunds = await dataSource
      .getRepository(WalletTransaction)
      .count({
        where: {
          userId: payLater.login.user.id,
          transactionType: WalletTransactionType.REFUND,
        },
      });
    expect(laterRefunds).toBe(0);

    const replay = await request(app.getHttpServer())
      .post(`/admin/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .send({ reason: 'Ops pre-trip cancellation again' })
      .expect(200);
    expect(replay.body.alreadyApplied).toBe(true);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          userId: payNow.login.user.id,
          transactionType: WalletTransactionType.REFUND,
        },
      }),
    ).toBe(1);
    expect(
      await dataSource.getRepository(AdminRideCancellation).count({
        where: { rideId: ride.id },
      }),
    ).toBe(1);
  });

  it('releases Assured deposits without forfeiture and advances the queue', async () => {
    const admin = await createAdmin([ADMIN_PERMISSION_RIDES_MANAGE]);
    const first = await publishableDriver(RideType.ASSURED, 4, 500);
    const second = await publishableDriver(RideType.ASSURED, 4, 500);
    const passenger = await fundedPassenger(5000n);
    await bookRide(
      passenger.login.accessToken,
      first.ride.id,
      BookingPaymentMethod.ASSURED_DEPOSIT,
      1,
      { farePayment: BookingFarePayment.PAY_LATER },
    );

    const firstRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: first.ride.id });
    const secondBefore = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: second.ride.id });
    expect(firstRow.status).toBe(RideStatus.ASSURANCE_ACTIVE);

    const cancel = await request(app.getHttpServer())
      .post(`/admin/rides/${first.ride.id}/cancel`)
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .send({ reason: 'Assured ops cancel' })
      .expect(200);
    expect(cancel.body.compensationTotal).toBe('0');
    expect(BigInt(cancel.body.depositReleaseTotal) > 0n).toBe(true);

    const driverHold = await dataSource.getRepository(WalletHold).findOne({
      where: {
        id:
          firstRow.driverDepositHoldId ??
          '00000000-0000-4000-8000-000000000000',
      },
    });
    if (driverHold) {
      expect(driverHold.status).toBe(WalletHoldStatus.RELEASED);
    }
    const forbiddenTypes = await dataSource
      .getRepository(WalletTransaction)
      .find({
        where: {
          userId: In([first.login.user.id, passenger.login.user.id]),
          transactionType: In([
            WalletTransactionType.ASSURED_PLATFORM_FORFEITURE,
            WalletTransactionType.ASSURED_RIDER_COMPENSATION,
            WalletTransactionType.HOLD_CONSUMED,
          ]),
        },
      });
    expect(forbiddenTypes).toHaveLength(0);

    const secondAfter = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: second.ride.id });
    if (secondBefore.status === RideStatus.ASSURANCE_PENDING) {
      expect(secondAfter.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    }
  });

  it('cancels a Commute occurrence and THIS_AND_FUTURE without touching past or completed', async () => {
    const admin = await createAdmin([ADMIN_PERMISSION_RIDES_MANAGE]);
    const { login, ride } = await publishableDriver(RideType.COMMUTE, 3, 100);
    const occurrences: Array<{ id: string; departureDate: string }> =
      ride.series?.occurrences ?? [];
    expect(occurrences.length).toBeGreaterThan(2);
    const first = occurrences[0];
    const second = occurrences[1];
    const last = occurrences[occurrences.length - 1];
    await dataSource.getRepository(Ride).update(last.id, {
      status: RideStatus.COMPLETED,
      completedAt: new Date(),
    });

    const passenger = await fundedPassenger();
    const pending = await bookRide(
      passenger.login.accessToken,
      second.id,
      BookingPaymentMethod.PAY_NOW,
    );
    await request(app.getHttpServer())
      .post(`/bookings/${pending.body.id}/accept`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    const cancel = await request(app.getHttpServer())
      .post(`/admin/rides/${second.id}/cancel`)
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .send({
        reason: 'Series ops cancel',
        seriesScope: SeriesScope.THIS_AND_FUTURE,
      })
      .expect(200);
    expect(cancel.body.occurrences.length).toBeGreaterThan(1);

    const firstRow = await dataSource.getRepository(Ride).findOneByOrFail({
      id: first.id,
    });
    expect(firstRow.status).toBe(RideStatus.PUBLISHED);
    const secondRow = await dataSource.getRepository(Ride).findOneByOrFail({
      id: second.id,
    });
    expect(secondRow.status).toBe(RideStatus.CANCELLED);
    const lastRow = await dataSource.getRepository(Ride).findOneByOrFail({
      id: last.id,
    });
    expect(lastRow.status).toBe(RideStatus.COMPLETED);

    const bookingRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: pending.body.id });
    expect(bookingRow.status).toBe(BookingStatus.CANCELLED);
    expect(bookingRow.paymentStatus).toBe(BookingPaymentStatus.REFUNDED);
  });

  it('cancels IN_PROGRESS rides with zero automatic refund or compensation', async () => {
    const admin = await createAdmin([ADMIN_PERMISSION_RIDES_MANAGE]);
    const { login, ride, wallet } = await publishableDriver(
      RideType.REGULAR,
      3,
      200,
    );
    const payNow = await fundedPassenger(1000n);
    const payLater = await fundedPassenger(1000n);
    const nowBooking = await bookRide(
      payNow.login.accessToken,
      ride.id,
      BookingPaymentMethod.PAY_NOW,
    );
    const laterBooking = await bookRide(
      payLater.login.accessToken,
      ride.id,
      BookingPaymentMethod.PAY_LATER,
    );

    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: 80n,
      sourceType: WalletPointSource.DRIVER_EARNED,
      transactionType: WalletTransactionType.DRIVER_EARNING,
      idempotencyKey: uniqueIdempotencyKey('admin-earning'),
    });
    const earningsBefore = await dataSource
      .getRepository(WalletTransaction)
      .count({
        where: {
          userId: login.user.id,
          transactionType: WalletTransactionType.DRIVER_EARNING,
        },
      });
    const txBefore = await dataSource.getRepository(WalletTransaction).count({
      where: { userId: payNow.login.user.id },
    });

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );
    await dataSource.getRepository(Booking).update(laterBooking.body.id, {
      pickupStatus: BookingPickupStatus.WAITING_FOR_PICKUP,
    });

    const cancel = await request(app.getHttpServer())
      .post(`/admin/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .send({ reason: 'Safety stop by operations' })
      .expect(200);
    expect(cancel.body.refundTotal).toBe('0');
    expect(cancel.body.compensationTotal).toBe('0');
    expect(cancel.body.supportEscalationRequired).toBe(true);
    expect(cancel.body.previousStatus).toBe(RideStatus.IN_PROGRESS);

    const paid = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: nowBooking.body.id });
    expect(paid.status).toBe(BookingStatus.CANCELLED);
    expect(paid.paymentStatus).toBe(BookingPaymentStatus.PAID);
    expect(paid.pickupStatus).toBe(BookingPickupStatus.PICKED_UP);

    const refunds = await dataSource.getRepository(WalletTransaction).count({
      where: {
        userId: payNow.login.user.id,
        transactionType: WalletTransactionType.REFUND,
      },
    });
    expect(refunds).toBe(0);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { userId: payNow.login.user.id },
      }),
    ).toBe(txBefore);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          userId: login.user.id,
          transactionType: WalletTransactionType.DRIVER_EARNING,
        },
      }),
    ).toBe(earningsBefore);

    const passengerNote = await dataSource.getRepository(Notification).findOne({
      where: {
        recipientUserId: payNow.login.user.id,
        type: NotificationType.ADMIN_RIDE_CANCELLED,
      },
    });
    expect(passengerNote?.body).toContain(ADMIN_OPS_PASSENGER_CANCEL_BODY);
    expect(passengerNote?.body).toContain(`Ride ID: ${ride.id}`);
    const driverNote = await dataSource.getRepository(Notification).findOne({
      where: {
        recipientUserId: login.user.id,
        type: NotificationType.ADMIN_RIDE_CANCELLED,
      },
    });
    expect(driverNote?.body).toContain(ADMIN_OPS_DRIVER_CANCEL_BODY);
    expect(driverNote?.body).toContain(`Ride ID: ${ride.id}`);

    const audit = await dataSource
      .getRepository(AdminRideCancellation)
      .findOneByOrFail({ rideId: ride.id });
    expect(audit.supportEscalationRequired).toBe(true);
    expect(audit.refundTotal).toBe('0');
    expect(audit.compensationTotal).toBe('0');

    if (redis && String(redis.status) === 'ready') {
      expect(await redis.get(rideTrackingKey(ride.id))).toBeNull();
    }
  });

  it('rejects completed rides and invalid payloads', async () => {
    const admin = await createAdmin([ADMIN_PERMISSION_RIDES_MANAGE]);
    const { ride } = await publishableDriver();
    await dataSource.getRepository(Ride).update(ride.id, {
      status: RideStatus.COMPLETED,
      completedAt: new Date(),
    });
    await request(app.getHttpServer())
      .post(`/admin/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .send({ reason: 'Cannot reverse completed' })
      .expect(409);

    const live = await publishableDriver();
    await request(app.getHttpServer())
      .post(`/admin/rides/${live.ride.id}/cancel`)
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .send({ reason: 'ab' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/admin/rides/${live.ride.id}/cancel`)
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .send({ reason: 'Valid reason', seriesScope: 'ALL' })
      .expect(400);
  });

  it('serializes concurrent admin cancellations without duplicate refunds', async () => {
    const admin = await createAdmin([ADMIN_PERMISSION_RIDES_MANAGE]);
    const { login, ride } = await publishableDriver();
    const passenger = await fundedPassenger(1000n);
    await bookRide(
      passenger.login.accessToken,
      ride.id,
      BookingPaymentMethod.PAY_NOW,
    );

    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .post(`/admin/rides/${ride.id}/cancel`)
        .set('Authorization', `Bearer ${admin.login.accessToken}`)
        .send({ reason: 'Concurrent A' }),
      request(app.getHttpServer())
        .post(`/admin/rides/${ride.id}/cancel`)
        .set('Authorization', `Bearer ${admin.login.accessToken}`)
        .send({ reason: 'Concurrent B' }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 200]);
    const applied = [first.body, second.body];
    expect(applied.some((row) => row.alreadyApplied === true)).toBe(true);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          userId: passenger.login.user.id,
          transactionType: WalletTransactionType.REFUND,
        },
      }),
    ).toBe(1);
    expect(
      await dataSource.getRepository(Notification).count({
        where: {
          recipientUserId: login.user.id,
          type: NotificationType.ADMIN_RIDE_CANCELLED,
        },
      }),
    ).toBe(1);
    expect(
      await dataSource.getRepository(Notification).count({
        where: {
          recipientUserId: passenger.login.user.id,
          type: NotificationType.ADMIN_RIDE_CANCELLED,
        },
      }),
    ).toBe(1);
  });

  it('preserves a prior driver cancellation without a second audit rewrite', async () => {
    const admin = await createAdmin([ADMIN_PERMISSION_RIDES_MANAGE]);
    const { login, ride } = await publishableDriver();
    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    const replay = await request(app.getHttpServer())
      .post(`/admin/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${admin.login.accessToken}`)
      .send({ reason: 'Already cancelled by driver' })
      .expect(200);
    expect(replay.body.alreadyApplied).toBe(true);
    const rideRow = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(rideRow.cancellationReason).toBe(
      RideCancellationReason.DRIVER_CANCELLED,
    );
    expect(
      await dataSource.getRepository(AdminRideCancellation).count({
        where: { rideId: ride.id },
      }),
    ).toBe(0);
  });
});
