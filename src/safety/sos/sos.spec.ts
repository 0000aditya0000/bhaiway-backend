/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource, In } from 'typeorm';

import { AdminModule } from '../../admin/admin.module';
import {
  ADMIN_PERMISSION_DASHBOARD_VIEW,
  ADMIN_PERMISSION_INCIDENTS_MANAGE,
  ADMIN_PERMISSION_INCIDENTS_VIEW,
  ADMIN_PERMISSION_SOS_MANAGE,
  ADMIN_PERMISSION_SOS_VIEW,
} from '../../admin/admin.constants';
import { AdminUser } from '../../admin/entities/admin-user.entity';
import { AuthModule } from '../../auth/auth.module';
import { AuthService } from '../../auth/auth.service';
import { Msg91ResponseFormatError } from '../../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../../auth/providers/otp-provider.interface';
import { BookingsModule } from '../../bookings/bookings.module';
import { Booking } from '../../bookings/entities/booking.entity';
import {
  BookingPaymentMethod,
  BookingStatus,
} from '../../bookings/enums/booking.enums';
import { deleteChatForBookingIds } from '../../chat/test/chat-test.helpers';
import { Notification } from '../../notifications/entities/notification.entity';
import { NotificationType } from '../../notifications/enums/notification.enums';
import { Ride } from '../../rides/entities/ride.entity';
import { RideStatus, RideType } from '../../rides/enums/ride.enums';
import { RidesModule } from '../../rides/rides.module';
import { futureCivilDate } from '../../rides/test/ride-departure-test.helpers';
import { withSelectedRoute } from '../../rides/test/selected-route-test.helpers';
import {
  REDIS_CLIENT,
  RIDE_TRACKING_STALE_AFTER_MS,
  rideParticipantTrackingKey,
  rideTrackingKey,
} from '../../tracking/tracking.constants';
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
import { Wallet } from '../../wallet/entities/wallet.entity';
import { WalletModule } from '../../wallet/wallet.module';
import { WalletService } from '../../wallet/wallet.service';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  creditTestWalletPoints,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../../wallet/test/wallet-test.helpers';
import { SafetyIncident } from './entities/safety-incident.entity';
import { SosEvent } from './entities/sos-event.entity';
import { SosTimelineEvent } from './entities/sos-timeline-event.entity';
import { SosTrigger } from './entities/sos-trigger.entity';
import {
  SosLocationFreshness,
  SosStatus,
  SosTimelineEventType,
} from './enums/sos.enums';
import { SafetyModule } from '../safety.module';
import {
  applySosEmergencySchema,
  deleteSosForRideIds,
} from './test/apply-sos-schema';

describe('SOS emergency response (integration)', () => {
  jest.setTimeout(90_000);

  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  let redis: Redis | null = null;
  const tracked: TestWalletContext[] = [];
  const rideIds: string[] = [];

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
        VerificationModule,
        VehiclesModule,
        RidesModule,
        BookingsModule,
        AdminModule,
        SafetyModule,
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
    try {
      redis = moduleRef.get<Redis>(REDIS_CLIENT);
    } catch {
      redis = null;
    }

    await applySosEmergencySchema(dataSource);
  });

  afterEach(async () => {
    const ids = [...rideIds];
    rideIds.length = 0;
    if (redis) {
      for (const id of ids) {
        await redis.del(rideTrackingKey(id));
      }
    }
    await deleteSosForRideIds(dataSource, ids);

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
      const userRideIds = [
        ...new Set([
          ...driverRides.map((ride) => ride.id),
          ...passengerBookings.map((booking) => booking.rideId),
        ]),
      ];
      if (redis) {
        for (const id of userRideIds) {
          await redis.del(rideTrackingKey(id));
          await redis.del(rideParticipantTrackingKey(id, ctx.userId));
        }
      }
      await deleteSosForRideIds(dataSource, userRideIds);
      const bookingIds = (
        await dataSource.getRepository(Booking).find({
          where:
            userRideIds.length > 0
              ? { rideId: In(userRideIds) }
              : { passengerId: ctx.userId },
          select: { id: true },
        })
      ).map((row) => row.id);
      if (bookingIds.length > 0) {
        await dataSource.query(
          `DELETE FROM rating_tasks WHERE booking_id = ANY($1::uuid[])`,
          [bookingIds],
        );
        await deleteChatForBookingIds(dataSource, bookingIds);
        await dataSource.getRepository(Booking).delete({ id: In(bookingIds) });
      }
      if (userRideIds.length > 0) {
        await dataSource.query(
          `DELETE FROM gst_invoices WHERE ride_id = ANY($1::uuid[])`,
          [userRideIds],
        );
        await dataSource.query(
          `DELETE FROM no_show_claims WHERE ride_id = ANY($1::uuid[])`,
          [userRideIds],
        );
        await dataSource.getRepository(Ride).delete({ id: In(userRideIds) });
      }
      await dataSource.getRepository(Vehicle).delete({ userId: ctx.userId });
      await dataSource
        .getRepository(UserProfile)
        .delete({ userId: ctx.userId });
      await dataSource
        .getRepository(UserVerification)
        .delete({ userId: ctx.userId });
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
    await app?.close();
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

  async function publishableDriver(totalSeats = 3) {
    const { login, wallet } = await createAuthenticatedUser();
    await dataSource.getRepository(UserProfile).save(
      dataSource.getRepository(UserProfile).create({
        userId: login.user.id,
        firstName: 'Sos',
        lastName: 'Driver',
        displayName: 'Sos Driver',
        gender: null,
        dateOfBirth: null,
        profilePhoto: null,
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

    const rideResponse = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(
        withSelectedRoute({
          rideType: RideType.REGULAR,
          vehicleId: vehicle.id,
          source: 'SOS Source',
          destination: 'SOS Dest',
          departureDate: futureCivilDate(14),
          departureTime: '09:00',
          totalSeats,
          pricePerSeat: 200,
        }),
      )
      .expect(201);
    rideIds.push(rideResponse.body.id);
    return { login, wallet, vehicle, ride: rideResponse.body };
  }

  async function fundedPassenger(name = 'Passenger') {
    const { login, wallet } = await createAuthenticatedUser();
    await dataSource.getRepository(UserProfile).save(
      dataSource.getRepository(UserProfile).create({
        userId: login.user.id,
        firstName: 'Sos',
        lastName: name,
        displayName: name,
        gender: null,
        dateOfBirth: null,
        profilePhoto: null,
      }),
    );
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await creditTestWalletPoints(
      walletService,
      wallet.id,
      login.user.id,
      10000n,
      'sos-passenger',
    );
    return { login, wallet };
  }

  async function bookRide(token: string, rideId: string) {
    return request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rideId,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);
  }

  async function startRide(driverToken: string, rideId: string) {
    await request(app.getHttpServer())
      .post(`/rides/${rideId}/start`)
      .set('Authorization', `Bearer ${driverToken}`)
      .expect(200);
  }

  async function createAdmin(permissions: string[]) {
    const { login } = await createAuthenticatedUser();
    await dataSource.getRepository(AdminUser).save(
      dataSource.getRepository(AdminUser).create({
        userId: login.user.id,
        username: `sos_${login.user.id.slice(0, 8)}`,
        passwordHash: 'x',
        permissions,
        isActive: true,
      }),
    );
    return login;
  }

  async function inProgressRideWithPassengers(passengerCount = 2) {
    const driver = await publishableDriver(Math.max(3, passengerCount + 1));
    const passengers = [];
    for (let i = 0; i < passengerCount; i += 1) {
      const passenger = await fundedPassenger(`Rider${i + 1}`);
      await bookRide(passenger.login.accessToken, driver.ride.id);
      passengers.push(passenger);
    }
    await startRide(driver.login.accessToken, driver.ride.id);
    return { driver, passengers };
  }

  it('allows driver and confirmed passengers to trigger SOS only on IN_PROGRESS rides', async () => {
    const driver = await publishableDriver();
    const passenger = await fundedPassenger('Eligible');
    const stranger = await fundedPassenger('Stranger');
    await bookRide(passenger.login.accessToken, driver.ride.id);

    await request(app.getHttpServer())
      .post(`/rides/${driver.ride.id}/sos`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .send({ idempotencyKey: uniqueIdempotencyKey('sos-pub') })
      .expect(409);

    await startRide(driver.login.accessToken, driver.ride.id);

    const driverSos = await request(app.getHttpServer())
      .post(`/rides/${driver.ride.id}/sos`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        idempotencyKey: uniqueIdempotencyKey('sos-drv'),
        latitude: 28.61,
        longitude: 77.2,
      })
      .expect(200);
    expect(driverSos.body.status).toBe(SosStatus.TRIGGERED);
    expect(driverSos.body.created).toBe(true);

    await request(app.getHttpServer())
      .post(`/rides/${driver.ride.id}/sos`)
      .set('Authorization', `Bearer ${stranger.login.accessToken}`)
      .send({ idempotencyKey: uniqueIdempotencyKey('sos-str') })
      .expect(404);

    const otherRide = await publishableDriver();
    await startRide(otherRide.login.accessToken, otherRide.ride.id);
    await request(app.getHttpServer())
      .post(`/rides/${otherRide.ride.id}/sos`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .send({ idempotencyKey: uniqueIdempotencyKey('sos-other') })
      .expect(404);
  });

  it('rejects cancelled and completed rides and cancelled bookings', async () => {
    const { driver, passengers } = await inProgressRideWithPassengers(1);
    const rideId = driver.ride.id;
    await dataSource
      .getRepository(Ride)
      .update({ id: rideId }, { status: RideStatus.CANCELLED });
    await request(app.getHttpServer())
      .post(`/rides/${rideId}/sos`)
      .set('Authorization', `Bearer ${passengers[0].login.accessToken}`)
      .send({ idempotencyKey: uniqueIdempotencyKey('sos-can') })
      .expect(409);

    await dataSource
      .getRepository(Ride)
      .update({ id: rideId }, { status: RideStatus.COMPLETED });
    await request(app.getHttpServer())
      .post(`/rides/${rideId}/sos`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ idempotencyKey: uniqueIdempotencyKey('sos-done') })
      .expect(409);

    const second = await inProgressRideWithPassengers(1);
    await dataSource.getRepository(Booking).update(
      {
        rideId: second.driver.ride.id,
        passengerId: second.passengers[0].login.user.id,
      },
      { status: BookingStatus.CANCELLED },
    );
    await request(app.getHttpServer())
      .post(`/rides/${second.driver.ride.id}/sos`)
      .set('Authorization', `Bearer ${second.passengers[0].login.accessToken}`)
      .send({ idempotencyKey: uniqueIdempotencyKey('sos-bc') })
      .expect(404);
  });

  it('attaches additional triggers to one active SOS and one incident', async () => {
    const { driver, passengers } = await inProgressRideWithPassengers(2);
    const rideId = driver.ride.id;
    const a = passengers[0];
    const b = passengers[1];
    const first = await request(app.getHttpServer())
      .post(`/rides/${rideId}/sos`)
      .set('Authorization', `Bearer ${a.login.accessToken}`)
      .send({
        idempotencyKey: uniqueIdempotencyKey('sos-a'),
        latitude: 28.61,
        longitude: 77.21,
      })
      .expect(200);

    const originalTriggeredAt = first.body.triggeredAt;

    const sameKey = uniqueIdempotencyKey('sos-idem');
    const firstIdem = await request(app.getHttpServer())
      .post(`/rides/${rideId}/sos`)
      .set('Authorization', `Bearer ${b.login.accessToken}`)
      .send({ idempotencyKey: sameKey })
      .expect(200);
    const retry = await request(app.getHttpServer())
      .post(`/rides/${rideId}/sos`)
      .set('Authorization', `Bearer ${b.login.accessToken}`)
      .send({ idempotencyKey: sameKey })
      .expect(200);

    expect(firstIdem.body.sosId).toBe(first.body.sosId);
    expect(retry.body.sosId).toBe(first.body.sosId);
    expect(first.body.originalTriggerUserId).toBe(a.login.user.id);
    expect(firstIdem.body.originalTriggerUserId).toBe(a.login.user.id);
    expect(firstIdem.body.triggeredAt).toBe(originalTriggeredAt);
    expect(firstIdem.body.attachedToExisting).toBe(true);

    const sosRows = await dataSource.getRepository(SosEvent).find({
      where: { rideId },
    });
    expect(sosRows).toHaveLength(1);
    const incidents = await dataSource.getRepository(SafetyIncident).find({
      where: { sosId: first.body.sosId },
    });
    expect(incidents).toHaveLength(1);
    const triggers = await dataSource.getRepository(SosTrigger).find({
      where: { sosId: first.body.sosId },
    });
    expect(triggers.filter((row) => row.isOriginal)).toHaveLength(1);
    expect(triggers.some((row) => row.userId === b.login.user.id)).toBe(true);

    const driverAlerts = await dataSource.getRepository(Notification).find({
      where: {
        recipientUserId: driver.login.user.id,
        type: NotificationType.SOS_DRIVER_ALERT,
      },
    });
    expect(driverAlerts).toHaveLength(1);
    expect(driverAlerts[0].body).toContain('SOS TRIGGERED FOR YOUR RIDE');
    const passengerAlerts = await dataSource.getRepository(Notification).find({
      where: { type: NotificationType.SOS_PASSENGER_ALERT },
    });
    expect(
      passengerAlerts.every((row) => row.recipientUserId !== a.login.user.id),
    ).toBe(true);
    expect(
      passengerAlerts.some((row) => row.recipientUserId === b.login.user.id),
    ).toBe(true);
    expect(
      passengerAlerts.some(
        (row) =>
          row.recipientUserId ===
          strangerId(tracked, [
            driver.login.user.id,
            a.login.user.id,
            b.login.user.id,
          ]),
      ),
    ).toBe(false);
  });

  it('does not create two active SOS records under concurrent triggers', async () => {
    const { driver, passengers } = await inProgressRideWithPassengers(2);
    const rideId = driver.ride.id;
    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .post(`/rides/${rideId}/sos`)
        .set('Authorization', `Bearer ${passengers[0].login.accessToken}`)
        .send({ idempotencyKey: uniqueIdempotencyKey('sos-c1') }),
      request(app.getHttpServer())
        .post(`/rides/${rideId}/sos`)
        .set('Authorization', `Bearer ${passengers[1].login.accessToken}`)
        .send({ idempotencyKey: uniqueIdempotencyKey('sos-c2') }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.sosId).toBe(second.body.sosId);
    const active = await dataSource.getRepository(SosEvent).find({
      where: {
        rideId,
        status: In([
          SosStatus.TRIGGERED,
          SosStatus.ACKNOWLEDGED,
          SosStatus.RESPONDING,
        ]),
      },
    });
    expect(active).toHaveLength(1);
    const incidents = await dataSource.getRepository(SafetyIncident).find({
      where: { sosId: first.body.sosId },
    });
    expect(incidents).toHaveLength(1);
  });

  it('lets authorized admins manage SOS lifecycle and blocks drivers/passengers', async () => {
    const { driver, passengers } = await inProgressRideWithPassengers(1);
    const rideId = driver.ride.id;
    const created = await request(app.getHttpServer())
      .post(`/rides/${rideId}/sos`)
      .set('Authorization', `Bearer ${passengers[0].login.accessToken}`)
      .send({ idempotencyKey: uniqueIdempotencyKey('sos-adm') })
      .expect(200);
    const sosId = created.body.sosId as string;

    await request(app.getHttpServer())
      .post(`/admin/sos/${sosId}/acknowledge`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/admin/sos/${sosId}/resolve`)
      .set('Authorization', `Bearer ${passengers[0].login.accessToken}`)
      .send({ reason: 'Passenger cannot resolve' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/rides/${rideId}/sos/dismiss`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(404);

    const viewer = await createAdmin([ADMIN_PERMISSION_DASHBOARD_VIEW]);
    await request(app.getHttpServer())
      .get('/admin/sos')
      .set('Authorization', `Bearer ${viewer.accessToken}`)
      .expect(403);

    const admin = await createAdmin([
      ADMIN_PERMISSION_SOS_VIEW,
      ADMIN_PERMISSION_SOS_MANAGE,
      ADMIN_PERMISSION_INCIDENTS_VIEW,
      ADMIN_PERMISSION_INCIDENTS_MANAGE,
    ]);

    await request(app.getHttpServer())
      .post(`/admin/sos/${sosId}/acknowledge`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/admin/sos/${sosId}/acknowledge`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    const ackEvents = await dataSource.getRepository(SosTimelineEvent).find({
      where: { sosId, eventType: SosTimelineEventType.ACKNOWLEDGED },
    });
    expect(ackEvents).toHaveLength(1);

    await request(app.getHttpServer())
      .post(`/admin/sos/${sosId}/start-response`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/admin/sos/${sosId}/resolve`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ reason: 'Safe and accounted for' })
      .expect(200);

    const stillActive = await dataSource.getRepository(SosEvent).find({
      where: {
        rideId,
        status: In([
          SosStatus.TRIGGERED,
          SosStatus.ACKNOWLEDGED,
          SosStatus.RESPONDING,
        ]),
      },
    });
    expect(stillActive).toHaveLength(0);
    const incident = await dataSource
      .getRepository(SafetyIncident)
      .findOneByOrFail({
        sosId,
      });
    expect(incident.status).not.toBe('RESOLVED');

    const listed = await request(app.getHttpServer())
      .get('/admin/sos')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(
      listed.body.items.some((item: { sosId: string }) => item.sosId === sosId),
    ).toBe(true);

    const detail = await request(app.getHttpServer())
      .get(`/admin/sos/${sosId}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(detail.body.sos.status).toBe(SosStatus.RESOLVED);
    expect(detail.body.incident.id).toBe(incident.id);

    await request(app.getHttpServer())
      .post(`/admin/incidents/${incident.id}/acknowledge`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/admin/incidents/${incident.id}/assign-to-me`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/admin/incidents/${incident.id}/notes`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ body: 'Called driver' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/admin/incidents/${incident.id}/escalate`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/admin/incidents/${incident.id}/resolve`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ reason: 'Investigation complete' })
      .expect(200);
  });

  it('marks false alarm with a reason and does not delete the SOS', async () => {
    const { driver, passengers } = await inProgressRideWithPassengers(1);
    const created = await request(app.getHttpServer())
      .post(`/rides/${driver.ride.id}/sos`)
      .set('Authorization', `Bearer ${passengers[0].login.accessToken}`)
      .send({ idempotencyKey: uniqueIdempotencyKey('sos-fa') })
      .expect(200);
    const admin = await createAdmin([
      ADMIN_PERMISSION_SOS_VIEW,
      ADMIN_PERMISSION_SOS_MANAGE,
    ]);
    await request(app.getHttpServer())
      .post(`/admin/sos/${created.body.sosId}/false-alarm`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post(`/admin/sos/${created.body.sosId}/false-alarm`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ reason: 'Accidental press' })
      .expect(200);
    const sos = await dataSource
      .getRepository(SosEvent)
      .findOneByOrFail({ id: created.body.sosId });
    expect(sos.status).toBe(SosStatus.FALSE_ALARM);
    const incident = await dataSource
      .getRepository(SafetyIncident)
      .findOneByOrFail({ sosId: sos.id });
    expect(incident.status).toBe('RESOLVED');
  });

  it('returns participant locations with freshness and never mixes coordinates', async () => {
    const { driver, passengers } = await inProgressRideWithPassengers(2);
    const rideId = driver.ride.id;
    const created = await request(app.getHttpServer())
      .post(`/rides/${rideId}/sos`)
      .set('Authorization', `Bearer ${passengers[0].login.accessToken}`)
      .send({
        idempotencyKey: uniqueIdempotencyKey('sos-loc'),
        latitude: 28.5,
        longitude: 77.1,
        accuracy: 8,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/tracking/rides/${rideId}/location`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ latitude: 28.7, longitude: 77.3 })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/rides/${rideId}/sos/location`)
      .set('Authorization', `Bearer ${passengers[0].login.accessToken}`)
      .send({ latitude: 28.55, longitude: 77.15, accuracy: 5 })
      .expect(200);

    if (redis) {
      await redis.set(
        rideParticipantTrackingKey(rideId, passengers[1].login.user.id),
        JSON.stringify({
          latitude: 28.4,
          longitude: 77.0,
          timestamp: new Date(
            Date.now() - RIDE_TRACKING_STALE_AFTER_MS - 5_000,
          ).toISOString(),
          updatedAt: new Date(
            Date.now() - RIDE_TRACKING_STALE_AFTER_MS - 5_000,
          ).toISOString(),
          accuracy: 12,
        }),
        'EX',
        120,
      );
    }

    const admin = await createAdmin([ADMIN_PERMISSION_SOS_VIEW]);
    const locations = await request(app.getHttpServer())
      .get(`/admin/sos/${created.body.sosId}/locations`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const byUser = new Map(
      locations.body.participants.map((row: { userId: string }) => [
        row.userId,
        row,
      ]),
    );
    const driverLoc = byUser.get(driver.login.user.id) as {
      latitude: number;
      freshness: string;
    };
    const triggerLoc = byUser.get(passengers[0].login.user.id) as {
      latitude: number;
      freshness: string;
    };
    const otherLoc = byUser.get(passengers[1].login.user.id) as {
      freshness: string;
      latitude: number | null;
    };
    expect(driverLoc.latitude).toBe(28.7);
    expect(triggerLoc.latitude).toBe(28.55);
    expect(driverLoc.latitude).not.toBe(triggerLoc.latitude);
    expect(otherLoc.freshness).toBe(SosLocationFreshness.STALE);

    const viewer = await createAdmin([ADMIN_PERMISSION_DASHBOARD_VIEW]);
    await request(app.getHttpServer())
      .get(`/admin/sos/${created.body.sosId}/locations`)
      .set('Authorization', `Bearer ${viewer.accessToken}`)
      .expect(403);

    const summary = await request(app.getHttpServer())
      .get('/admin/safety/live-monitoring/summary')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(summary.body.activeSosCount).toBeGreaterThanOrEqual(1);
    expect(summary.body.activeRideCount).toBeGreaterThanOrEqual(1);
    expect(summary.body.routeDeviationDetectionEnabled).toBe(false);
    expect(summary.body.routeDeviationCount).toBe(0);

    const map = await request(app.getHttpServer())
      .get('/admin/safety/live-monitoring/map')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(
      map.body.markers.every(
        (marker: { latitude: number; longitude: number }) =>
          marker.latitude != null && marker.longitude != null,
      ),
    ).toBe(true);
  });
});

function strangerId(tracked: TestWalletContext[], known: string[]): string {
  return (
    tracked.find((row) => !known.includes(row.userId))?.userId ??
    '00000000-0000-4000-8000-000000000000'
  );
}
