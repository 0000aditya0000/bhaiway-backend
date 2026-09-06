import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import request from 'supertest';

import { AssuredQueueService } from './assured-queue.service';
import { AssuredQueueAdvanceReason } from './enums/assured-queue.enums';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { BookingsModule } from '../bookings/bookings.module';
import { Booking } from '../bookings/entities/booking.entity';
import { deleteChatForBookingIds } from '../chat/test/chat-test.helpers';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import { withAssuredPublishHeaders } from '../rides/test/assured-ride-test.helpers';
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
import { WalletHold } from '../wallet/entities/wallet-hold.entity';
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

describe('Assured Queue Engine (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  let assuredQueueService: AssuredQueueService;
  const tracked: TestWalletContext[] = [];

  const ROUTE = {
    source: 'Noida Queue Hub',
    destination: 'Dehradun Queue Dest',
    sourceLatitude: 28.5355,
    sourceLongitude: 77.391,
    destinationLatitude: 30.3165,
    destinationLongitude: 78.0322,
  };

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
        SettingsModule,
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
    assuredQueueService = moduleRef.get(AssuredQueueService);
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        const passengerBookings = await dataSource.getRepository(Booking).find({
          where: { passengerId: ctx.userId },
          select: { id: true },
        });
        const rides = await dataSource.getRepository(Ride).find({
          where: { driverId: ctx.userId },
        });
        const rideBookingIds =
          rides.length === 0
            ? []
            : (
                await dataSource.getRepository(Booking).find({
                  where: { rideId: In(rides.map((r) => r.id)) },
                  select: { id: true },
                })
              ).map((b) => b.id);
        await deleteChatForBookingIds(dataSource, [
          ...passengerBookings.map((b) => b.id),
          ...rideBookingIds,
        ]);
        await dataSource.getRepository(Booking).delete({
          passengerId: ctx.userId,
        });
        const queueIds = [
          ...new Set(
            rides
              .map((ride) => ride.assuredQueueId)
              .filter((id): id is string => id != null),
          ),
        ];
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
            await dataSource.query(
              `DELETE FROM assured_geographic_queues WHERE id = $1`,
              [queueId],
            );
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
    if (app) {
      await app.close();
    }
  });

  async function createAuthenticatedUser(displayName = 'Queue User') {
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
        firstName: 'Queue',
        lastName: 'Test',
        displayName,
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example.com/queue.jpg',
      }),
    );

    return { login, wallet, phone };
  }

  async function markVerified(userId: string, type: VerificationType) {
    await markVerificationVerified(
      verificationService,
      dataSource,
      userId,
      type,
    );
  }

  async function createVehicle(userId: string) {
    return vehiclesService.create(userId, {
      vehicleType: VehicleType.CAR,
      make: 'Toyota',
      model: 'Innova',
      variant: 'Crysta',
      registrationNumber: `DL01${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10)}`,
      registrationYear: 2023,
      color: 'Silver',
      seatingCapacity: 6,
    });
  }

  async function publishableDriver(credit = 5000n) {
    const { login, wallet } = await createAuthenticatedUser('Driver');
    const vehicle = await createVehicle(login.user.id);
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
    await markVerified(login.user.id, VerificationType.VEHICLE);
    if (credit > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: credit,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('queue-driver'),
      });
    }
    return { login, wallet, vehicle };
  }

  async function verifiedPassenger(credit = 5000n) {
    const { login, wallet } = await createAuthenticatedUser('Passenger');
    await markVerified(login.user.id, VerificationType.IDENTITY);
    if (credit > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: credit,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('queue-passenger'),
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
      departureDate: '2026-08-30',
      departureTime: '13:15',
      totalSeats: 4,
      pricePerSeat: 300,
      maxTwoInBackSeat: true,
      noSmoking: true,
      noPets: true,
      luggageAllowed: true,
      ...ROUTE,
      ...overrides,
    };
  }

  async function publishAssured(
    driverToken: string,
    vehicleId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const res = await request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(driverToken))
      .send(assuredPayload(vehicleId, overrides))
      .expect(201);
    return res.body as { id: string; status: RideStatus };
  }

  async function searchAssured(passengerToken: string, date = '2026-08-30') {
    const res = await request(app.getHttpServer())
      .get('/rides/search')
      .query({
        source: ROUTE.source,
        destination: ROUTE.destination,
        date,
        seats: 1,
        rideType: RideType.ASSURED,
      })
      .set('Authorization', `Bearer ${passengerToken}`)
      .expect(200);
    return res.body.items as Array<{ id: string }>;
  }

  function bookAssured(
    passengerToken: string,
    rideId: string,
    seats = 1,
    key = uniqueIdempotencyKey('queue-book'),
  ) {
    return request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passengerToken}`)
      .set('Idempotency-Key', key)
      .send({
        rideId,
        seats,
        paymentMethod: 'ASSURED_DEPOSIT',
      });
  }

  it('1: first Assured ride in queue becomes ASSURANCE_ACTIVE', async () => {
    const { login, vehicle } = await publishableDriver();
    const ride = await publishAssured(login.accessToken, vehicle.id);
    expect(ride.status).toBe(RideStatus.ASSURANCE_ACTIVE);
  });

  it('2–3: second and third same-window rides become ASSURANCE_PENDING', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const d3 = await publishableDriver();

    const a = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureTime: '13:10',
    });
    const b = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '13:40',
    });
    const c = await publishAssured(d3.login.accessToken, d3.vehicle.id, {
      departureTime: '13:55',
    });

    expect(a.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(b.status).toBe(RideStatus.ASSURANCE_PENDING);
    expect(c.status).toBe(RideStatus.ASSURANCE_PENDING);
  });

  it('4: ride in different 1-hour window becomes ASSURANCE_ACTIVE', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureTime: '13:15',
    });
    const evening = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '17:10',
    });
    expect(evening.status).toBe(RideStatus.ASSURANCE_ACTIVE);
  });

  it('5–6: search returns ACTIVE across windows, not PENDING', async () => {
    const passenger = await verifiedPassenger();
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const d3 = await publishableDriver();

    const morning = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureTime: '13:15',
    });
    await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '13:45',
    });
    const evening = await publishAssured(d3.login.accessToken, d3.vehicle.id, {
      departureTime: '17:10',
    });

    const items = await searchAssured(passenger.login.accessToken);
    const ids = items.map((item) => item.id);
    expect(ids).toContain(morning.id);
    expect(ids).toContain(evening.id);
    expect(ids).not.toContain(
      (
        await dataSource.getRepository(Ride).findOne({
          where: {
            driverId: d2.login.user.id,
            status: RideStatus.ASSURANCE_PENDING,
          },
        })
      )?.id,
    );
    expect(items).toHaveLength(2);
  });

  it('7–8: PENDING not bookable; ACTIVE bookable', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const passenger = await verifiedPassenger();

    const active = await publishAssured(d1.login.accessToken, d1.vehicle.id);
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '13:40',
    });

    await bookAssured(passenger.login.accessToken, pending.id).expect(400);
    await bookAssured(
      passenger.login.accessToken,
      active.id,
      1,
      uniqueIdempotencyKey('active-book'),
    ).expect(201);
  });

  it('9–10: FULL promotes next PENDING rides in FIFO order', async () => {
    const driver1 = await publishableDriver();
    const driver2 = await publishableDriver();
    const driver3 = await publishableDriver();
    const passenger = await verifiedPassenger(20000n);

    const a = await publishAssured(
      driver1.login.accessToken,
      driver1.vehicle.id,
      { totalSeats: 1 },
    );
    const b = await publishAssured(
      driver2.login.accessToken,
      driver2.vehicle.id,
      { departureTime: '13:20', totalSeats: 1 },
    );
    const c = await publishAssured(
      driver3.login.accessToken,
      driver3.vehicle.id,
      { departureTime: '13:25', totalSeats: 1 },
    );

    await bookAssured(passenger.login.accessToken, a.id).expect(201);

    const bRow = await dataSource.getRepository(Ride).findOneByOrFail({
      id: b.id,
    });
    const cRow = await dataSource.getRepository(Ride).findOneByOrFail({
      id: c.id,
    });
    expect(bRow.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(cRow.status).toBe(RideStatus.ASSURANCE_PENDING);

    await bookAssured(
      passenger.login.accessToken,
      b.id,
      1,
      uniqueIdempotencyKey('full-b'),
    ).expect(201);

    const cAfter = await dataSource.getRepository(Ride).findOneByOrFail({
      id: c.id,
    });
    expect(cAfter.status).toBe(RideStatus.ASSURANCE_ACTIVE);
  });

  it('11: rider cancellation does not promote queue', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const passenger = await verifiedPassenger();

    const active = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      totalSeats: 4,
    });
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '13:40',
    });

    const booking = await bookAssured(passenger.login.accessToken, active.id);
    const bookingId = booking.body.id as string;

    await request(app.getHttpServer())
      .post(`/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    const pendingRow = await dataSource.getRepository(Ride).findOneByOrFail({
      id: pending.id,
    });
    expect(pendingRow.status).toBe(RideStatus.ASSURANCE_PENDING);
  });

  it('12: driver cancellation promotes next PENDING', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    const active = await publishAssured(d1.login.accessToken, d1.vehicle.id);
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '13:40',
    });

    await request(app.getHttpServer())
      .post(`/rides/${active.id}/cancel`)
      .set('Authorization', `Bearer ${d1.login.accessToken}`)
      .expect(200);

    const pendingRow = await dataSource.getRepository(Ride).findOneByOrFail({
      id: pending.id,
    });
    expect(pendingRow.status).toBe(RideStatus.ASSURANCE_ACTIVE);
  });

  it('13: driver no-show of sole ACTIVE promotes next PENDING', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const passenger = await verifiedPassenger();
    const pastDate = '2020-01-01';

    const active = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureDate: pastDate,
      departureTime: '13:10',
      totalSeats: 2,
    });
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureDate: pastDate,
      departureTime: '13:40',
      totalSeats: 2,
    });
    expect(pending.status).toBe(RideStatus.ASSURANCE_PENDING);

    await bookAssured(passenger.login.accessToken, active.id).expect(201);

    await request(app.getHttpServer())
      .post(`/rides/${active.id}/driver-no-show`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    const [activeAfter, pendingAfter] = await Promise.all([
      dataSource.getRepository(Ride).findOneByOrFail({ id: active.id }),
      dataSource.getRepository(Ride).findOneByOrFail({ id: pending.id }),
    ]);
    expect(activeAfter.status).toBe(RideStatus.CANCELLED);
    expect(pendingAfter.status).toBe(RideStatus.ASSURANCE_ACTIVE);
  });

  it('13b: COMPLETE of ACTIVE does not promote PENDING siblings', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    const active = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureTime: '15:10',
    });
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '15:40',
    });
    expect(pending.status).toBe(RideStatus.ASSURANCE_PENDING);

    await request(app.getHttpServer())
      .post(`/rides/${active.id}/start`)
      .set('Authorization', `Bearer ${d1.login.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/rides/${active.id}/complete`)
      .set('Authorization', `Bearer ${d1.login.accessToken}`)
      .expect(200);

    const [activeAfter, pendingAfter] = await Promise.all([
      dataSource.getRepository(Ride).findOneByOrFail({ id: active.id }),
      dataSource.getRepository(Ride).findOneByOrFail({ id: pending.id }),
    ]);
    expect(activeAfter.status).toBe(RideStatus.COMPLETED);
    expect(pendingAfter.status).toBe(RideStatus.ASSURANCE_PENDING);
  });

  it('14–15: FORCE_PUBLISH promotes at most one eligible PENDING ride', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const forceDate = '2026-09-15';

    const active = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureDate: forceDate,
      departureTime: '13:10',
    });
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureDate: forceDate,
      departureTime: '13:40',
    });
    expect(pending.status).toBe(RideStatus.ASSURANCE_PENDING);

    await dataSource.getRepository(Ride).update(active.id, {
      status: RideStatus.CANCELLED,
    });

    const queueId = (
      await dataSource.getRepository(Ride).findOneByOrFail({ id: pending.id })
    ).assuredQueueId!;

    await dataSource.transaction(async (manager) => {
      const first = await assuredQueueService.forcePublishInTransaction(
        manager,
        queueId,
        `queue-force-op:${queueId}:test-1`,
      );
      const second = await assuredQueueService.forcePublishInTransaction(
        manager,
        queueId,
        `queue-force-op:${queueId}:test-1`,
      );
      expect(first.promotedRide?.id).toBe(pending.id);
      expect(second.alreadyApplied).toBe(true);
    });

    const actives = await dataSource.getRepository(Ride).count({
      where: {
        assuredQueueId: queueId,
        status: RideStatus.ASSURANCE_ACTIVE,
        rideType: RideType.ASSURED,
      },
    });
    expect(actives).toBe(1);
  });

  it('16: concurrent publish yields exactly one ACTIVE per queue', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    const [r1, r2] = await Promise.all([
      publishAssured(d1.login.accessToken, d1.vehicle.id, {
        departureTime: '14:05',
      }),
      publishAssured(d2.login.accessToken, d2.vehicle.id, {
        departureTime: '14:10',
      }),
    ]);

    const rows = await dataSource.getRepository(Ride).find({
      where: { id: In([r1.id, r2.id]) },
    });
    const activeCount = rows.filter(
      (row) => row.status === RideStatus.ASSURANCE_ACTIVE,
    ).length;
    expect(activeCount).toBe(1);
  });

  it('23: driver deposit remains while ride is PENDING', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    await publishAssured(d1.login.accessToken, d1.vehicle.id);
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '13:40',
    });

    const hold = await dataSource.getRepository(WalletHold).findOne({
      where: { referenceId: pending.id },
    });
    expect(hold?.status).toBe('ACTIVE');
    expect(hold?.amount).toBe('60');
  });

  it('30: PENDING re-queue on schedule change', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureTime: '13:10',
    });
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '13:20',
    });

    await request(app.getHttpServer())
      .patch(`/rides/${pending.id}`)
      .set('Authorization', `Bearer ${d2.login.accessToken}`)
      .send({ departureTime: '17:15' })
      .expect(200);

    const updated = await dataSource.getRepository(Ride).findOneByOrFail({
      id: pending.id,
    });
    expect(updated.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(updated.assuranceWindowStart).toBe('17:00:00');
  });

  it('31: queue advancement idempotent on retry', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    const active = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      totalSeats: 1,
    });
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '13:40',
      totalSeats: 1,
    });
    const passenger = await verifiedPassenger();

    await bookAssured(passenger.login.accessToken, active.id).expect(201);

    const queueId = (
      await dataSource.getRepository(Ride).findOneByOrFail({ id: pending.id })
    ).assuredQueueId!;

    const results = await dataSource.transaction(async (manager) => {
      const first = await assuredQueueService.advanceQueueInTransaction(
        manager,
        {
          queueId,
          reason: AssuredQueueAdvanceReason.FULL,
          sourceRideId: active.id,
          idempotencyKey: `queue-advance:${queueId}:FULL:${active.id}`,
        },
      );
      const second = await assuredQueueService.advanceQueueInTransaction(
        manager,
        {
          queueId,
          reason: AssuredQueueAdvanceReason.FULL,
          sourceRideId: active.id,
          idempotencyKey: `queue-advance:${queueId}:FULL:${active.id}`,
        },
      );
      return [first, second];
    });

    expect(results[0].promotedRide?.id).toBe(pending.id);
    expect(results[1].alreadyApplied).toBe(true);
  });

  it('22: forcePublish is not exposed as an HTTP route', async () => {
    const d1 = await publishableDriver();
    const ride = await publishAssured(d1.login.accessToken, d1.vehicle.id);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/force-publish`)
      .set('Authorization', `Bearer ${d1.login.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/assured/queues/${ride.id}/force-publish`)
      .set('Authorization', `Bearer ${d1.login.accessToken}`)
      .expect(404);
  });
});
