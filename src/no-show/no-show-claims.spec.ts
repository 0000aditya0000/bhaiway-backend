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
  BookingCancellationReason,
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingPickupStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { decryptPickupOtp } from '../bookings/pickup-otp.util';
import { deleteChatForBookingIds } from '../chat/test/chat-test.helpers';
import { currentCivilClock } from '../common/time/ride-timezone';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationType } from '../notifications/enums/notification.enums';
import { NotificationsService } from '../notifications/notifications.service';
import { Ride } from '../rides/entities/ride.entity';
import {
  RideCancellationReason,
  RideStatus,
  RideType,
} from '../rides/enums/ride.enums';
import { RegularRideCancellationService } from '../rides/regular-ride-cancellation.service';
import { RidesModule } from '../rides/rides.module';
import { SupportTicket } from '../support/entities/support-ticket.entity';
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
import {
  WalletTransaction,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { NoShowClaimEffect } from './entities/no-show-claim-effect.entity';
import { NoShowClaim } from './entities/no-show-claim.entity';
import {
  NoShowClaimEffectKind,
  NoShowClaimEffectStatus,
  NoShowClaimKind,
  NoShowClaimStatus,
  NoShowDecisionSource,
} from './enums/no-show.enums';
import { NO_SHOW_CLAIM_ALREADY_REJECTED } from './errors/no-show.errors';
import { NO_SHOW_ELIGIBLE_AFTER_MS } from './no-show.constants';
import { NoShowClaimsService } from './no-show-claims.service';
import {
  reportDriverNoShowAndApprove,
  reportPassengerNoShowAndApprove,
} from './test/no-show-http.helpers';
import { withSelectedRoute } from '../rides/test/selected-route-test.helpers';

function pickupOtpPepper(): string {
  const secret = process.env.JWT_ACCESS_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new Error('JWT_ACCESS_SECRET is required for pickup OTP tests');
  }
  return secret;
}

describe('No-Show claims (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  let noShowClaimsService: NoShowClaimsService;
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
    noShowClaimsService = moduleRef.get(NoShowClaimsService);
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (!ctx) {
        continue;
      }
      await dataSource.getRepository(NoShowClaim).delete({
        claimantUserId: ctx.userId,
      });
      await dataSource.getRepository(NoShowClaim).delete({
        respondentUserId: ctx.userId,
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
          await dataSource.query(
            `DELETE FROM rating_tasks WHERE booking_id = ANY($1::uuid[])`,
            [rideBookingIds],
          );
        }
        await dataSource.query(
          `DELETE FROM rating_tasks WHERE ride_id = $1`,
          [ride.id],
        );
        await deleteChatForBookingIds(dataSource, rideBookingIds);
        await dataSource.getRepository(Booking).delete({ rideId: ride.id });
      }
      const passengerBookings = await dataSource.getRepository(Booking).find({
        where: { passengerId: ctx.userId },
        select: { id: true },
      });
      const passengerBookingIds = passengerBookings.map((b) => b.id);
      if (passengerBookingIds.length > 0) {
        await dataSource.query(
          `DELETE FROM rating_tasks WHERE booking_id = ANY($1::uuid[])`,
          [passengerBookingIds],
        );
      }
      await deleteChatForBookingIds(dataSource, passengerBookingIds);
      await dataSource.getRepository(Booking).delete({
        passengerId: ctx.userId,
      });
      await dataSource.query(
        `DELETE FROM notification_email_deliveries
         WHERE notification_id IN (
           SELECT id FROM notifications WHERE recipient_user_id = $1
         )`,
        [ctx.userId],
      );
      await dataSource.getRepository(Notification).delete({
        recipientUserId: ctx.userId,
      });
      await dataSource.query(
        `DELETE FROM support_tickets WHERE user_id = $1`,
        [ctx.userId],
      );
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

    await dataSource.getRepository(UserProfile).save(
      dataSource.getRepository(UserProfile).create({
        userId: login.user.id,
        firstName: 'NoShow',
        lastName: 'User',
        displayName: 'NoShow User',
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example.com/user.jpg',
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

  async function publishDriver(rideType: RideType, totalSeats = 3) {
    const { login, wallet } = await createAuthenticatedUser();
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

    const rideResponse = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(withSelectedRoute({
        rideType,
        vehicleId: vehicle.id,
        source: 'Noida Sector 62',
        destination: 'Connaught Place',
        departureDate: '2027-08-20',
        departureTime: '09:00',
        totalSeats,
        pricePerSeat: 100,
      }))
      .expect(201);

    return { login, wallet, ride: rideResponse.body };
  }

  async function verifiedPassenger(credit = 0n) {
    const { login, wallet } = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);
    if (credit > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: credit,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('noshow-passenger-fund'),
      });
    }
    return { login, wallet };
  }

  async function setDepartureOffset(rideId: string, offsetMs: number) {
    const clock = currentCivilClock(new Date(Date.now() - offsetMs));
    await dataSource.getRepository(Ride).update(rideId, {
      departureDate: clock.date,
      departureTime: clock.time,
    });
  }

  async function bookRegular(
    token: string,
    rideId: string,
    paymentMethod = BookingPaymentMethod.PAY_LATER,
  ) {
    const req = request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ rideId, seats: 1, paymentMethod });
    if (paymentMethod === BookingPaymentMethod.PAY_NOW) {
      req.set('Idempotency-Key', uniqueIdempotencyKey('noshow-paynow'));
    }
    return req.expect(201);
  }

  it('rejects driver No-Show before the 5-minute boundary and allows it after', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    await bookRegular(passenger.login.accessToken, ride.id);

    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS - 15_000);
    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(409);

    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);
    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(opened.body.status).toBe(NoShowClaimStatus.PENDING);
    expect(opened.body.kind).toBe(NoShowClaimKind.DRIVER_NO_SHOW);
  });

  async function startRide(driverToken: string, rideId: string) {
    return request(app.getHttpServer())
      .post(`/rides/${rideId}/start`)
      .set('Authorization', `Bearer ${driverToken}`)
      .expect(200);
  }

  async function pickupOtpFor(bookingId: string) {
    const bookingRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: bookingId });
    expect(bookingRow.pickupOtpCiphertext).toBeTruthy();
    return decryptPickupOtp(
      bookingRow.pickupOtpCiphertext!,
      pickupOtpPepper(),
    );
  }

  it('allows Driver No-Show on an IN_PROGRESS ride after departure + 5 minutes if not picked up', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    await bookRegular(passenger.login.accessToken, ride.id);
    await startRide(driver.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(opened.body.status).toBe(NoShowClaimStatus.PENDING);
    expect(opened.body.kind).toBe(NoShowClaimKind.DRIVER_NO_SHOW);

    await request(app.getHttpServer())
      .post(`/no-show-claims/${opened.body.id}/approve`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.CANCELLED);
    expect(rideRow.cancellationReason).toBe(
      RideCancellationReason.DRIVER_NO_SHOW,
    );
  });

  it('rejects Driver No-Show on an IN_PROGRESS ride before the 5-minute threshold', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    await bookRegular(passenger.login.accessToken, ride.id);
    await startRide(driver.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS - 15_000);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(409);
  });

  it('rejects Driver No-Show after pickup and never penalizes a picked-up passenger', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    const booking = await bookRegular(passenger.login.accessToken, ride.id);
    await startRide(driver.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const otp = await pickupOtpFor(booking.body.id);
    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ otp })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(409);

    const { login: driver2, ride: ride2 } = await publishDriver(RideType.REGULAR);
    const booking2 = await bookRegular(passenger.login.accessToken, ride2.id);
    await setDepartureOffset(ride2.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);
    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride2.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    await startRide(driver2.accessToken, ride2.id);
    const otp2 = await pickupOtpFor(booking2.body.id);
    await request(app.getHttpServer())
      .post(`/bookings/${booking2.body.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver2.accessToken}`)
      .send({ otp: otp2 })
      .expect(200);

    const resolved = await request(app.getHttpServer())
      .post(`/no-show-claims/${opened.body.id}/approve`)
      .set('Authorization', `Bearer ${driver2.accessToken}`)
      .expect(200);
    expect(resolved.body.status).toBe(NoShowClaimStatus.REJECTED);
    expect(resolved.body.settledAt).toBeNull();

    const afterBooking = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking2.body.id });
    expect(afterBooking.status).toBe(BookingStatus.CONFIRMED);
    expect(afterBooking.pickupStatus).toBe(BookingPickupStatus.PICKED_UP);
    expect(afterBooking.cancellationReason).toBeNull();

    const afterRide = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride2.id });
    expect(afterRide.status).toBe(RideStatus.IN_PROGRESS);
    expect(afterRide.cancellationReason).toBeNull();
  });

  it('rejects a new Driver No-Show claim on completed or cancelled rides', async () => {
    const { login: completedDriver, ride: completedRide } = await publishDriver(
      RideType.REGULAR,
    );
    const completedPassenger = await verifiedPassenger();
    const completedBooking = await bookRegular(
      completedPassenger.login.accessToken,
      completedRide.id,
    );
    await startRide(completedDriver.accessToken, completedRide.id);
    const completedOtp = await pickupOtpFor(completedBooking.body.id);
    await request(app.getHttpServer())
      .post(`/bookings/${completedBooking.body.id}/verify-pickup`)
      .set('Authorization', `Bearer ${completedDriver.accessToken}`)
      .send({ otp: completedOtp })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/rides/${completedRide.id}/complete`)
      .set('Authorization', `Bearer ${completedDriver.accessToken}`)
      .expect(200);
    await setDepartureOffset(
      completedRide.id,
      NO_SHOW_ELIGIBLE_AFTER_MS + 15_000,
    );
    await request(app.getHttpServer())
      .post(`/rides/${completedRide.id}/no-show/driver`)
      .set('Authorization', `Bearer ${completedPassenger.login.accessToken}`)
      .expect(409);

    const { login: cancelledDriver, ride: cancelledRide } = await publishDriver(
      RideType.REGULAR,
    );
    const cancelledPassenger = await verifiedPassenger();
    await bookRegular(cancelledPassenger.login.accessToken, cancelledRide.id);
    await request(app.getHttpServer())
      .post(`/rides/${cancelledRide.id}/cancel`)
      .set('Authorization', `Bearer ${cancelledDriver.accessToken}`)
      .expect(200);
    await setDepartureOffset(
      cancelledRide.id,
      NO_SHOW_ELIGIBLE_AFTER_MS + 15_000,
    );
    await request(app.getHttpServer())
      .post(`/rides/${cancelledRide.id}/no-show/driver`)
      .set('Authorization', `Bearer ${cancelledPassenger.login.accessToken}`)
      .expect(409);
  });

  it('pickup racing with Driver No-Show create or approval cannot invalid-settle', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    const booking = await bookRegular(passenger.login.accessToken, ride.id);
    await startRide(driver.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);
    const otp = await pickupOtpFor(booking.body.id);

    const [pickupCreateRes, createRes] = await Promise.all([
      request(app.getHttpServer())
        .post(`/bookings/${booking.body.id}/verify-pickup`)
        .set('Authorization', `Bearer ${driver.accessToken}`)
        .send({ otp }),
      request(app.getHttpServer())
        .post(`/rides/${ride.id}/no-show/driver`)
        .set('Authorization', `Bearer ${passenger.login.accessToken}`),
    ]);

    expect([200, 409]).toContain(pickupCreateRes.status);
    expect([200, 409]).toContain(createRes.status);

    const afterCreateBooking = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    if (createRes.status === 200) {
      const created = await dataSource
        .getRepository(NoShowClaim)
        .findOneByOrFail({ id: createRes.body.id });
      expect(created.status).toBe(NoShowClaimStatus.PENDING);
      if (afterCreateBooking.pickupStatus === BookingPickupStatus.PICKED_UP) {
        const rejected = await request(app.getHttpServer())
          .post(`/no-show-claims/${created.id}/approve`)
          .set('Authorization', `Bearer ${driver.accessToken}`)
          .expect(200);
        expect(rejected.body.status).toBe(NoShowClaimStatus.REJECTED);
        const rideAfterReject = await dataSource
          .getRepository(Ride)
          .findOneByOrFail({ id: ride.id });
        expect(rideAfterReject.status).toBe(RideStatus.IN_PROGRESS);
        expect(rideAfterReject.cancellationReason).toBeNull();
      }
    } else {
      expect(pickupCreateRes.status).toBe(200);
      expect(afterCreateBooking.pickupStatus).toBe(
        BookingPickupStatus.PICKED_UP,
      );
    }

    const { login: driver2, ride: ride2 } = await publishDriver(RideType.REGULAR);
    const passenger2 = await verifiedPassenger();
    const booking2 = await bookRegular(passenger2.login.accessToken, ride2.id);
    await setDepartureOffset(ride2.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);
    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride2.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger2.login.accessToken}`)
      .expect(200);
    await startRide(driver2.accessToken, ride2.id);
    const otp2 = await pickupOtpFor(booking2.body.id);

    const [pickupApproveRes, approveRes] = await Promise.all([
      request(app.getHttpServer())
        .post(`/bookings/${booking2.body.id}/verify-pickup`)
        .set('Authorization', `Bearer ${driver2.accessToken}`)
        .send({ otp: otp2 }),
      request(app.getHttpServer())
        .post(`/no-show-claims/${opened.body.id}/approve`)
        .set('Authorization', `Bearer ${driver2.accessToken}`),
    ]);

    expect([200, 409]).toContain(pickupApproveRes.status);
    expect(approveRes.status).toBe(200);

    const claim = await dataSource
      .getRepository(NoShowClaim)
      .findOneByOrFail({ id: opened.body.id });
    const afterApproveBooking = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking2.body.id });
    const afterApproveRide = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride2.id });

    expect(
      claim.status === NoShowClaimStatus.APPROVED &&
        afterApproveBooking.pickupStatus === BookingPickupStatus.PICKED_UP,
    ).toBe(false);
    if (afterApproveBooking.pickupStatus === BookingPickupStatus.PICKED_UP) {
      expect(claim.status).toBe(NoShowClaimStatus.REJECTED);
      expect(afterApproveBooking.status).toBe(BookingStatus.CONFIRMED);
      expect(afterApproveBooking.cancellationReason).toBeNull();
      expect(afterApproveRide.status).toBe(RideStatus.IN_PROGRESS);
      expect(afterApproveRide.cancellationReason).toBeNull();
    }
    if (claim.status === NoShowClaimStatus.APPROVED) {
      expect(afterApproveRide.status).toBe(RideStatus.CANCELLED);
      expect(afterApproveRide.cancellationReason).toBe(
        RideCancellationReason.DRIVER_NO_SHOW,
      );
      expect(afterApproveBooking.status).toBe(BookingStatus.CANCELLED);
      expect(afterApproveBooking.pickupStatus).not.toBe(
        BookingPickupStatus.PICKED_UP,
      );
    }
  });

  it('rejects unauthorized reporters and duplicate pending driver claims', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    const stranger = await verifiedPassenger();
    await bookRegular(passenger.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .expect(401);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${stranger.login.accessToken}`)
      .expect(404);

    const first = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    const second = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/driver-no-show`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.alreadyOpen).toBe(true);
  });

  it('Regular driver No-Show approval cancels the ride without refunds; reject does not', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const p1 = await verifiedPassenger(5000n);
    const p2 = await verifiedPassenger();
    await bookRegular(
      p1.login.accessToken,
      ride.id,
      BookingPaymentMethod.PAY_NOW,
    );
    await bookRegular(p2.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const rejectedOpen = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${p1.login.accessToken}`)
      .expect(200);

    const unauthorizedApprove = await request(app.getHttpServer())
      .post(`/no-show-claims/${rejectedOpen.body.id}/approve`)
      .set('Authorization', `Bearer ${p1.login.accessToken}`)
      .expect(404);
    expect(unauthorizedApprove.body).toMatchObject({
      message: 'No-Show claim not found',
    });
    expect(unauthorizedApprove.body.claimantUserId).toBeUndefined();
    expect(unauthorizedApprove.body.respondentUserId).toBeUndefined();

    const rejected = await request(app.getHttpServer())
      .post(`/no-show-claims/${rejectedOpen.body.id}/reject`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
    expect(rejected.body.status).toBe(NoShowClaimStatus.REJECTED);
    expect(rejected.body.support).toBeTruthy();

    const rideStillOpen = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideStillOpen.status).toBe(RideStatus.PUBLISHED);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          walletId: p1.wallet.id,
          transactionType: WalletTransactionType.REFUND,
        },
      }),
    ).toBe(0);
    expect(
      await dataSource.getRepository(SupportTicket).count({
        where: { userId: p1.login.user.id },
      }),
    ).toBe(1);

    const { login: settleDriver, ride: settleRide } = await publishDriver(
      RideType.REGULAR,
    );
    const settlePayNow = await bookRegular(
      p1.login.accessToken,
      settleRide.id,
      BookingPaymentMethod.PAY_NOW,
    );
    const settlePayLater = await bookRegular(p2.login.accessToken, settleRide.id);
    await setDepartureOffset(settleRide.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    await reportDriverNoShowAndApprove(
      app,
      settleRide.id,
      p1.login.accessToken,
      settleDriver.accessToken,
    );

    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: settleRide.id });
    expect(rideRow.status).toBe(RideStatus.CANCELLED);
    expect(rideRow.cancellationReason).toBe(
      RideCancellationReason.DRIVER_NO_SHOW,
    );
    const booking1 = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: settlePayNow.body.id });
    const booking2 = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: settlePayLater.body.id });
    expect(booking1.status).toBe(BookingStatus.CANCELLED);
    expect(booking2.status).toBe(BookingStatus.CANCELLED);
    expect(booking1.cancellationReason).toBe(
      BookingCancellationReason.DRIVER_NO_SHOW,
    );
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          walletId: p1.wallet.id,
          transactionType: WalletTransactionType.REFUND,
        },
      }),
    ).toBe(0);
  });

  it('Regular passenger No-Show cancels only that booking and restores seats', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR, 3);
    const p1 = await verifiedPassenger();
    const p2 = await verifiedPassenger();
    const b1 = await bookRegular(p1.login.accessToken, ride.id);
    const b2 = await bookRegular(p2.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const seatsBefore = (
      await dataSource.getRepository(Ride).findOneByOrFail({ id: ride.id })
    ).availableSeats;

    await reportPassengerNoShowAndApprove(
      app,
      b1.body.id,
      driver.accessToken,
      p1.login.accessToken,
    );

    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.PUBLISHED);
    expect(rideRow.availableSeats).toBe(seatsBefore + 1);

    const cancelled = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: b1.body.id });
    const other = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: b2.body.id });
    expect(cancelled.status).toBe(BookingStatus.CANCELLED);
    expect(cancelled.cancellationReason).toBe(
      BookingCancellationReason.RIDER_NO_SHOW,
    );
    expect(other.status).toBe(BookingStatus.CONFIRMED);
  });

  it('timeout auto-approves through the same settlement path', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    await bookRegular(passenger.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    await dataSource.getRepository(NoShowClaim).update(opened.body.id, {
      respondBy: new Date(Date.now() - 1000),
    });

    const settled = await noShowClaimsService.processDueClaims();
    expect(settled).toBeGreaterThanOrEqual(1);

    const claim = await dataSource
      .getRepository(NoShowClaim)
      .findOneByOrFail({ id: opened.body.id });
    expect(claim.status).toBe(NoShowClaimStatus.APPROVED);
    expect(claim.decisionSource).toBe(NoShowDecisionSource.TIMEOUT);
    expect(claim.settlementIdempotencyKey).toBe(
      `no-show-settle:${opened.body.id}`,
    );

    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.CANCELLED);

    await noShowClaimsService.processDueClaims();
    expect(
      await dataSource.getRepository(NoShowClaim).count({
        where: { id: opened.body.id, status: NoShowClaimStatus.APPROVED },
      }),
    ).toBe(1);

    const timeoutNotes = await dataSource.getRepository(Notification).count({
      where: {
        recipientUserId: passenger.login.user.id,
        type: NotificationType.NO_SHOW_CLAIM_TIMEOUT,
      },
    });
    expect(timeoutNotes).toBe(1);
  });

  it('driver claim approval supersedes pending passenger claims without passenger penalties', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR, 3);
    const p1 = await verifiedPassenger();
    const p2 = await verifiedPassenger();
    const b1 = await bookRegular(p1.login.accessToken, ride.id);
    await bookRegular(p2.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const passengerClaim = await request(app.getHttpServer())
      .post(`/bookings/${b1.body.id}/no-show/passenger`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    await reportDriverNoShowAndApprove(
      app,
      ride.id,
      p2.login.accessToken,
      driver.accessToken,
    );

    const superseded = await dataSource
      .getRepository(NoShowClaim)
      .findOneByOrFail({ id: passengerClaim.body.id });
    expect(superseded.status).toBe(NoShowClaimStatus.SUPERSEDED);
    const booking1 = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: b1.body.id });
    expect(booking1.cancellationReason).toBe(
      BookingCancellationReason.DRIVER_NO_SHOW,
    );
  });

  it('concurrent approve and reject produce a single terminal outcome', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    await bookRegular(passenger.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    const [approveRes, rejectRes] = await Promise.all([
      request(app.getHttpServer())
        .post(`/no-show-claims/${opened.body.id}/approve`)
        .set('Authorization', `Bearer ${driver.accessToken}`),
      request(app.getHttpServer())
        .post(`/no-show-claims/${opened.body.id}/reject`)
        .set('Authorization', `Bearer ${driver.accessToken}`),
    ]);

    const statuses = [approveRes.status, rejectRes.status].sort();
    expect(statuses).toEqual([200, 409]);
    const claim = await dataSource
      .getRepository(NoShowClaim)
      .findOneByOrFail({ id: opened.body.id });
    expect(
      [NoShowClaimStatus.APPROVED, NoShowClaimStatus.REJECTED].includes(
        claim.status,
      ),
    ).toBe(true);
  });

  it('Commute driver No-Show refunds all active bookings; passenger No-Show refunds only that booking', async () => {
    const { login: driver, ride } = await publishDriver(RideType.COMMUTE, 3);
    const p1 = await verifiedPassenger(5000n);
    const p2 = await verifiedPassenger(5000n);

    const req1 = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${p1.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('noshow-c1'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);
    const req2 = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${p2.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('noshow-c2'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/bookings/${req1.body.id}/no-show/passenger`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(409);

    await request(app.getHttpServer())
      .post(`/bookings/${req1.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/bookings/${req2.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const seatsAfterAccept = (
      await dataSource.getRepository(Ride).findOneByOrFail({ id: ride.id })
    ).availableSeats;

    await reportPassengerNoShowAndApprove(
      app,
      req1.body.id,
      driver.accessToken,
      p1.login.accessToken,
    );

    const afterPassenger = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(afterPassenger.status).toBe(RideStatus.PUBLISHED);
    expect(afterPassenger.availableSeats).toBe(seatsAfterAccept + 1);
    const cancelledPassenger = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: req1.body.id });
    expect(cancelledPassenger.paymentStatus).toBe(BookingPaymentStatus.REFUNDED);
    const otherStillLive = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: req2.body.id });
    expect(otherStillLive.status).toBe(BookingStatus.CONFIRMED);

    await reportDriverNoShowAndApprove(
      app,
      ride.id,
      p2.login.accessToken,
      driver.accessToken,
    );
    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.CANCELLED);
    expect(rideRow.cancellationReason).toBe(
      RideCancellationReason.DRIVER_NO_SHOW,
    );
    const booking2 = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: req2.body.id });
    expect(booking2.paymentStatus).toBe(BookingPaymentStatus.REFUNDED);
  });

  it('GET is limited to claimant or respondent', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    const stranger = await verifiedPassenger();
    await bookRegular(passenger.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/no-show-claims/${opened.body.id}`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/no-show-claims/${opened.body.id}`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/no-show-claims/${opened.body.id}`)
      .set('Authorization', `Bearer ${stranger.login.accessToken}`)
      .expect(404);
  });

  it('rejects passenger No-Show settlement after pickup and notifies both parties', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    const booking = await bookRegular(passenger.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/no-show/passenger`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const bookingRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(bookingRow.pickupOtpCiphertext).toBeTruthy();
    const otp = decryptPickupOtp(
      bookingRow.pickupOtpCiphertext!,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ otp })
      .expect(200);

    const resolved = await request(app.getHttpServer())
      .post(`/no-show-claims/${opened.body.id}/approve`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(resolved.body.status).toBe(NoShowClaimStatus.REJECTED);
    expect(resolved.body.settledAt).toBeNull();
    expect(resolved.body.support).toBeTruthy();

    const after = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(after.status).toBe(BookingStatus.CONFIRMED);
    expect(after.pickupStatus).toBe(BookingPickupStatus.PICKED_UP);
    expect(after.cancellationReason).toBeNull();

    expect(
      await dataSource.getRepository(Notification).count({
        where: {
          recipientUserId: passenger.login.user.id,
          type: NotificationType.NO_SHOW_CLAIM_REJECTED,
        },
      }),
    ).toBe(1);
    expect(
      await dataSource.getRepository(Notification).count({
        where: {
          recipientUserId: driver.user.id,
          type: NotificationType.NO_SHOW_CLAIM_REJECTED,
        },
      }),
    ).toBe(1);
  });

  it('pickup vs passenger No-Show approval cannot both apply penalties', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    const booking = await bookRegular(passenger.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/no-show/passenger`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const bookingRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    const otp = decryptPickupOtp(
      bookingRow.pickupOtpCiphertext!,
      pickupOtpPepper(),
    );

    const [pickupRes, approveRes] = await Promise.all([
      request(app.getHttpServer())
        .post(`/bookings/${booking.body.id}/verify-pickup`)
        .set('Authorization', `Bearer ${driver.accessToken}`)
        .send({ otp }),
      request(app.getHttpServer())
        .post(`/no-show-claims/${opened.body.id}/approve`)
        .set('Authorization', `Bearer ${passenger.login.accessToken}`),
    ]);

    expect([200, 409]).toContain(pickupRes.status);
    expect(approveRes.status).toBe(200);

    const claim = await dataSource
      .getRepository(NoShowClaim)
      .findOneByOrFail({ id: opened.body.id });
    const after = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });

    expect(
      claim.status === NoShowClaimStatus.APPROVED &&
        after.pickupStatus === BookingPickupStatus.PICKED_UP,
    ).toBe(false);
    if (after.pickupStatus === BookingPickupStatus.PICKED_UP) {
      expect(claim.status).toBe(NoShowClaimStatus.REJECTED);
      expect(after.status).toBe(BookingStatus.CONFIRMED);
      expect(after.cancellationReason).toBeNull();
    }
    if (claim.status === NoShowClaimStatus.APPROVED) {
      expect(after.status).toBe(BookingStatus.CANCELLED);
      expect(after.cancellationReason).toBe(
        BookingCancellationReason.RIDER_NO_SHOW,
      );
      expect(after.pickupStatus).not.toBe(BookingPickupStatus.PICKED_UP);
    }
  });

  it('timeout after pickup rejects without passenger No-Show settlement', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    const booking = await bookRegular(passenger.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/no-show/passenger`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
    const bookingRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({
        otp: decryptPickupOtp(
          bookingRow.pickupOtpCiphertext!,
          pickupOtpPepper(),
        ),
      })
      .expect(200);

    await dataSource.getRepository(NoShowClaim).update(opened.body.id, {
      respondBy: new Date(Date.now() - 1000),
    });
    await noShowClaimsService.processDueClaims();

    const claim = await dataSource
      .getRepository(NoShowClaim)
      .findOneByOrFail({ id: opened.body.id });
    expect(claim.status).toBe(NoShowClaimStatus.REJECTED);
    expect(claim.settlementIdempotencyKey).toBeNull();
    const after = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(after.status).toBe(BookingStatus.CONFIRMED);
    expect(after.pickupStatus).toBe(BookingPickupStatus.PICKED_UP);
  });

  it('hides resolved claims from unauthorized callers and stays idempotent for the respondent', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    const stranger = await verifiedPassenger();
    await bookRegular(passenger.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/no-show-claims/${opened.body.id}/approve`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const strangerApprove = await request(app.getHttpServer())
      .post(`/no-show-claims/${opened.body.id}/approve`)
      .set('Authorization', `Bearer ${stranger.login.accessToken}`)
      .expect(404);
    expect(strangerApprove.body.message).toBe('No-Show claim not found');
    expect(strangerApprove.body.id).toBeUndefined();
    expect(strangerApprove.body.claimantUserId).toBeUndefined();
    expect(strangerApprove.body.respondentUserId).toBeUndefined();

    const claimantApprove = await request(app.getHttpServer())
      .post(`/no-show-claims/${opened.body.id}/approve`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(404);
    expect(claimantApprove.body.claimantUserId).toBeUndefined();

    const idempotent = await request(app.getHttpServer())
      .post(`/no-show-claims/${opened.body.id}/approve`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
    expect(idempotent.body.id).toBe(opened.body.id);
    expect(idempotent.body.status).toBe(NoShowClaimStatus.APPROVED);
  });

  it('blocks refiling a driver No-Show after REJECTED, including concurrent creates', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    await bookRegular(passenger.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/no-show-claims/${opened.body.id}/reject`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const refile = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(409);
    expect(refile.body.code).toBe(NO_SHOW_CLAIM_ALREADY_REJECTED);
    expect(refile.body.support).toBeTruthy();
    expect(String(refile.body.message)).toMatch(/Help & Support/i);

    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .post(`/rides/${ride.id}/no-show/driver`)
        .set('Authorization', `Bearer ${passenger.login.accessToken}`),
      request(app.getHttpServer())
        .post(`/rides/${ride.id}/driver-no-show`)
        .set('Authorization', `Bearer ${passenger.login.accessToken}`),
    ]);
    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(
      await dataSource.getRepository(NoShowClaim).count({
        where: {
          rideId: ride.id,
          kind: NoShowClaimKind.DRIVER_NO_SHOW,
          status: NoShowClaimStatus.PENDING,
        },
      }),
    ).toBe(0);
  });

  it('blocks refiling a passenger No-Show after REJECTED but not after SUPERSEDED', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR, 3);
    const p1 = await verifiedPassenger();
    const p2 = await verifiedPassenger();
    const b1 = await bookRegular(p1.login.accessToken, ride.id);
    const b2 = await bookRegular(p2.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const rejectedOpen = await request(app.getHttpServer())
      .post(`/bookings/${b1.body.id}/no-show/passenger`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/no-show-claims/${rejectedOpen.body.id}/reject`)
      .set('Authorization', `Bearer ${p1.login.accessToken}`)
      .expect(200);

    const refileRejected = await request(app.getHttpServer())
      .post(`/bookings/${b1.body.id}/no-show/passenger`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(409);
    expect(refileRejected.body.code).toBe(NO_SHOW_CLAIM_ALREADY_REJECTED);
    expect(refileRejected.body.support).toBeTruthy();

    const supersededOpen = await request(app.getHttpServer())
      .post(`/bookings/${b2.body.id}/no-show/passenger`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
    await dataSource.getRepository(NoShowClaim).update(supersededOpen.body.id, {
      status: NoShowClaimStatus.SUPERSEDED,
    });

    const refileSuperseded = await request(app.getHttpServer())
      .post(`/bookings/${b2.body.id}/no-show/passenger`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
    expect(refileSuperseded.body.status).toBe(NoShowClaimStatus.PENDING);
    expect(refileSuperseded.body.id).not.toBe(supersededOpen.body.id);
  });

  it('retries support ticket and notifications on repeated reject without reversing settlement', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    await bookRegular(passenger.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/no-show-claims/${opened.body.id}/reject`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const afterReject = await dataSource
      .getRepository(NoShowClaim)
      .findOneByOrFail({ id: opened.body.id });
    expect(afterReject.supportTicketId).toBeTruthy();
    const ticketId = afterReject.supportTicketId;

    await dataSource.getRepository(NoShowClaim).update(opened.body.id, {
      supportTicketId: null,
    });
    await dataSource.query(
      `DELETE FROM notification_email_deliveries
       WHERE notification_id IN (
         SELECT id FROM notifications
         WHERE recipient_user_id IN ($1, $2)
       )`,
      [passenger.login.user.id, driver.user.id],
    );
    await dataSource.getRepository(Notification).delete({
      recipientUserId: passenger.login.user.id,
    });
    await dataSource.getRepository(Notification).delete({
      recipientUserId: driver.user.id,
    });

    await dataSource.getRepository(NoShowClaimEffect).update(
      { claimId: opened.body.id, kind: NoShowClaimEffectKind.NOTIFY_RESOLVED },
      {
        status: NoShowClaimEffectStatus.PENDING,
        nextAttemptAt: null,
        completedAt: null,
        lastError: 'simulated lost notify',
      },
    );
    await dataSource.getRepository(NoShowClaimEffect).update(
      { claimId: opened.body.id, kind: NoShowClaimEffectKind.OPEN_SUPPORT },
      {
        status: NoShowClaimEffectStatus.PENDING,
        nextAttemptAt: null,
        completedAt: null,
        lastError: 'simulated lost support',
      },
    );

    const retried = await noShowClaimsService.processPendingEffects(
      opened.body.id,
    );
    expect(retried).toBeGreaterThanOrEqual(1);

    const afterRetry = await dataSource
      .getRepository(NoShowClaim)
      .findOneByOrFail({ id: opened.body.id });
    expect(afterRetry.status).toBe(NoShowClaimStatus.REJECTED);
    expect(afterRetry.supportTicketId).toBe(ticketId);

    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.PUBLISHED);

    expect(
      await dataSource.getRepository(Notification).count({
        where: {
          recipientUserId: passenger.login.user.id,
          type: NotificationType.NO_SHOW_CLAIM_REJECTED,
        },
      }),
    ).toBe(1);
    const notifyEffect = await dataSource
      .getRepository(NoShowClaimEffect)
      .findOneByOrFail({
        claimId: opened.body.id,
        kind: NoShowClaimEffectKind.NOTIFY_RESOLVED,
      });
    expect(notifyEffect.status).toBe(NoShowClaimEffectStatus.COMPLETED);
  });

  it('overlapping processDueClaims executions settle a due claim once', async () => {
    const { ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    await bookRegular(passenger.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    await dataSource.getRepository(NoShowClaim).update(opened.body.id, {
      respondBy: new Date(Date.now() - 1000),
    });

    const [first, second] = await Promise.all([
      noShowClaimsService.processDueClaims(),
      noShowClaimsService.processDueClaims(),
    ]);
    expect(first).toBe(1);
    expect(second).toBe(1);

    const claim = await dataSource
      .getRepository(NoShowClaim)
      .findOneByOrFail({ id: opened.body.id });
    expect(claim.status).toBe(NoShowClaimStatus.APPROVED);
    expect(claim.settlementIdempotencyKey).toBe(
      `no-show-settle:${opened.body.id}`,
    );
    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.CANCELLED);
  });

  it('rolls back the claim when settlement fails inside the transaction', async () => {
    const { login: driver, ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    await bookRegular(passenger.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    const spy = jest
      .spyOn(RegularRideCancellationService.prototype, 'cancelRideInTransaction')
      .mockRejectedValueOnce(new Error('simulated settlement failure'));
    try {
      await request(app.getHttpServer())
        .post(`/no-show-claims/${opened.body.id}/approve`)
        .set('Authorization', `Bearer ${driver.accessToken}`)
        .expect(500);
    } finally {
      spy.mockRestore();
    }

    const claim = await dataSource
      .getRepository(NoShowClaim)
      .findOneByOrFail({ id: opened.body.id });
    expect(claim.status).toBe(NoShowClaimStatus.PENDING);
    expect(claim.settlementIdempotencyKey).toBeNull();
    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.PUBLISHED);
  });

  it('retries timeout notifications from the effect outbox without HTTP or resettling', async () => {
    const { ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    await bookRegular(passenger.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    await dataSource.getRepository(NoShowClaim).update(opened.body.id, {
      respondBy: new Date(Date.now() - 1000),
    });

    const spy = jest
      .spyOn(NotificationsService.prototype, 'enqueueNoShowClaimResolved')
      .mockRejectedValue(new Error('simulated notify failure'));
    try {
      await noShowClaimsService.processDueClaims();
    } finally {
      spy.mockRestore();
    }

    const claim = await dataSource
      .getRepository(NoShowClaim)
      .findOneByOrFail({ id: opened.body.id });
    expect(claim.status).toBe(NoShowClaimStatus.APPROVED);
    expect(claim.settlementIdempotencyKey).toBe(
      `no-show-settle:${opened.body.id}`,
    );
    const pending = await dataSource
      .getRepository(NoShowClaimEffect)
      .findOneByOrFail({
        claimId: opened.body.id,
        kind: NoShowClaimEffectKind.NOTIFY_RESOLVED,
      });
    expect(pending.status).toBe(NoShowClaimEffectStatus.PENDING);
    expect(pending.lastError).toMatch(/simulated notify failure/);

    await dataSource.getRepository(NoShowClaimEffect).update(pending.id, {
      nextAttemptAt: null,
    });
    await noShowClaimsService.processPendingEffects(opened.body.id);

    const completed = await dataSource
      .getRepository(NoShowClaimEffect)
      .findOneByOrFail({ id: pending.id });
    expect(completed.status).toBe(NoShowClaimEffectStatus.COMPLETED);
    expect(
      await dataSource.getRepository(Notification).count({
        where: {
          recipientUserId: passenger.login.user.id,
          type: NotificationType.NO_SHOW_CLAIM_TIMEOUT,
        },
      }),
    ).toBe(1);
    const rideAfter = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideAfter.status).toBe(RideStatus.CANCELLED);
    expect(
      await dataSource.getRepository(NoShowClaim).count({
        where: {
          id: opened.body.id,
          status: NoShowClaimStatus.APPROVED,
        },
      }),
    ).toBe(1);
  });

  it('two independent worker instances settle one due Regular claim at most once', async () => {
    const { ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    await bookRegular(passenger.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    await dataSource.getRepository(NoShowClaim).update(opened.body.id, {
      respondBy: new Date(Date.now() - 1000),
    });

    const [first, secondCount] = await Promise.all([
      noShowClaimsService.processDueClaimsConcurrent(),
      noShowClaimsService.processDueClaimsConcurrent(),
    ]);
    expect(first + secondCount).toBeGreaterThanOrEqual(1);
    expect(Math.min(first, secondCount)).toBeLessThanOrEqual(1);

    const claim = await dataSource
      .getRepository(NoShowClaim)
      .findOneByOrFail({ id: opened.body.id });
    expect(claim.status).toBe(NoShowClaimStatus.APPROVED);
    expect(
      await dataSource.getRepository(NoShowClaim).count({
        where: { id: opened.body.id },
      }),
    ).toBe(1);
    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.CANCELLED);
  });

  it('two independent workers refund a Commute driver No-Show once', async () => {
    const { login: driver, ride } = await publishDriver(RideType.COMMUTE);
    const passenger = await verifiedPassenger(5000n);
    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('noshow-two-worker'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    await dataSource.getRepository(NoShowClaim).update(opened.body.id, {
      respondBy: new Date(Date.now() - 1000),
    });

    await Promise.all([
      noShowClaimsService.processDueClaimsConcurrent(),
      noShowClaimsService.processDueClaimsConcurrent(),
    ]);

    const settled = await dataSource
      .getRepository(NoShowClaim)
      .findOneByOrFail({ id: opened.body.id });
    expect(settled.status).toBe(NoShowClaimStatus.APPROVED);
    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.CANCELLED);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          walletId: passenger.wallet.id,
          transactionType: WalletTransactionType.REFUND,
        },
      }),
    ).toBe(1);
  });

  it('a failed worker transaction leaves the due claim recoverable by another instance', async () => {
    const { ride } = await publishDriver(RideType.REGULAR);
    const passenger = await verifiedPassenger();
    await bookRegular(passenger.login.accessToken, ride.id);
    await setDepartureOffset(ride.id, NO_SHOW_ELIGIBLE_AFTER_MS + 15_000);

    const opened = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/no-show/driver`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    await dataSource.getRepository(NoShowClaim).update(opened.body.id, {
      respondBy: new Date(Date.now() - 1000),
    });

    const spy = jest
      .spyOn(RegularRideCancellationService.prototype, 'cancelRideInTransaction')
      .mockRejectedValue(new Error('simulated worker crash'));
    try {
      await Promise.all([
        noShowClaimsService.processDueClaimsConcurrent(),
        noShowClaimsService.processDueClaimsConcurrent(),
      ]);
    } finally {
      spy.mockRestore();
    }

    const rolledBack = await dataSource
      .getRepository(NoShowClaim)
      .findOneByOrFail({ id: opened.body.id });
    expect(rolledBack.status).toBe(NoShowClaimStatus.PENDING);
    expect(rolledBack.settlementIdempotencyKey).toBeNull();

    await Promise.all([
      noShowClaimsService.processDueClaimsConcurrent(),
      noShowClaimsService.processDueClaimsConcurrent(),
    ]);

    const recovered = await dataSource
      .getRepository(NoShowClaim)
      .findOneByOrFail({ id: opened.body.id });
    expect(recovered.status).toBe(NoShowClaimStatus.APPROVED);
    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.CANCELLED);
  });
});
