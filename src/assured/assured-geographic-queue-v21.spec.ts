import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import request from 'supertest';

import { AssuredQueueService } from './assured-queue.service';
import { AssuredGeographicQueue } from './entities/assured-geographic-queue.entity';
import { buildAssuredQueueDestinationBucket } from './assured-route-compatibility';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { BookingsModule } from '../bookings/bookings.module';
import { Booking } from '../bookings/entities/booking.entity';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import { withAssuredPublishHeaders } from '../rides/test/assured-ride-test.helpers';
import { haversineMeters } from '../rides/route/route-geometry';
import { SettingsService } from '../settings/settings.service';
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

describe('Assured Geographic Queue V2.1 hardening (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  let settingsService: SettingsService;
  let assuredQueueService: AssuredQueueService;
  const tracked: TestWalletContext[] = [];

  const NOIDA = {
    source: 'Noida Hardening Hub',
    destination: 'Dehradun Hardening Dest',
    sourceLatitude: 28.5355,
    sourceLongitude: 77.391,
    destinationLatitude: 30.3165,
    destinationLongitude: 78.0322,
  };

  /** ~1km north of Dehradun — different 0.01° destination bucket, same corridor. */
  const NEARBY_DEST = {
    source: 'Noida Nearby Dest Hub',
    destination: 'Dehradun Nearby Dest',
    sourceLatitude: 28.5355,
    sourceLongitude: 77.391,
    destinationLatitude: 30.325,
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
    settingsService = moduleRef.get(SettingsService);
    assuredQueueService = moduleRef.get(AssuredQueueService);
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

  async function createAuthenticatedUser(displayName = 'V21 User') {
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
        firstName: 'V21',
        lastName: 'Test',
        displayName,
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example.com/v21.jpg',
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
        idempotencyKey: uniqueIdempotencyKey('v21-driver'),
      });
    }
    return { login, wallet, vehicle };
  }

  async function verifiedPassenger(credit = 20000n) {
    const { login, wallet } = await createAuthenticatedUser('Passenger');
    await markVerified(login.user.id, VerificationType.IDENTITY);
    if (credit > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: credit,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('v21-passenger'),
      });
    }
    return { login, wallet };
  }

  async function publishAssured(
    driverToken: string,
    vehicleId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const res = await request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(driverToken))
      .send({
        rideType: RideType.ASSURED,
        vehicleId,
        departureDate: '2026-10-10',
        departureTime: '13:15',
        totalSeats: 4,
        pricePerSeat: 300,
        maxTwoInBackSeat: true,
        noSmoking: true,
        noPets: true,
        luggageAllowed: true,
        ...NOIDA,
        ...overrides,
      })
      .expect(201);
    return res.body as { id: string; status: RideStatus };
  }

  async function bookRide(
    passengerToken: string,
    rideId: string,
    seats = 1,
  ) {
    return request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passengerToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('v21-book'))
      .send({
        rideId,
        seats,
        paymentMethod: 'ASSURED_DEPOSIT',
      })
      .expect(201);
  }

  async function setupFullWithSibling() {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const d3 = await publishableDriver();
    const passenger = await verifiedPassenger();

    const a = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      totalSeats: 1,
      departureTime: '13:10',
    });
    const b = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      totalSeats: 4,
      departureTime: '13:20',
    });
    const c = await publishAssured(d3.login.accessToken, d3.vehicle.id, {
      totalSeats: 4,
      departureTime: '13:30',
    });

    await bookRide(passenger.login.accessToken, a.id, 1);

    const [aRow, bRow, cRow] = await dataSource.getRepository(Ride).find({
      where: { id: In([a.id, b.id, c.id]) },
      order: { createdAt: 'ASC' },
    });

    expect(aRow.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(aRow.availableSeats).toBe(0);
    expect(bRow.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(bRow.availableSeats).toBeGreaterThan(0);
    expect(cRow.status).toBe(RideStatus.ASSURANCE_PENDING);
    expect(aRow.assuredQueueId).toBe(bRow.assuredQueueId);

    return { d1, d2, d3, passenger, a: aRow, b: bRow, c: cRow };
  }

  it('CRITICAL: rider cancel on FULL A demotes A to PENDING when B is bookable ACTIVE', async () => {
    const { passenger, a, b, c } = await setupFullWithSibling();
    const booking = await dataSource.getRepository(Booking).findOneByOrFail({
      rideId: a.id,
    });

    await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    const [aAfter, bAfter, cAfter] = await Promise.all([
      dataSource.getRepository(Ride).findOneByOrFail({ id: a.id }),
      dataSource.getRepository(Ride).findOneByOrFail({ id: b.id }),
      dataSource.getRepository(Ride).findOneByOrFail({ id: c.id }),
    ]);

    expect(aAfter.status).toBe(RideStatus.ASSURANCE_PENDING);
    expect(aAfter.availableSeats).toBe(1);
    expect(bAfter.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(bAfter.availableSeats).toBeGreaterThan(0);
    expect(cAfter.status).toBe(RideStatus.ASSURANCE_PENDING);
  });

  it('CRITICAL: driver cancel of FULL A does not promote C when B is bookable ACTIVE', async () => {
    const { d1, a, b, c } = await setupFullWithSibling();

    await request(app.getHttpServer())
      .post(`/rides/${a.id}/cancel`)
      .set('Authorization', `Bearer ${d1.login.accessToken}`)
      .expect(200);

    const [aAfter, bAfter, cAfter] = await Promise.all([
      dataSource.getRepository(Ride).findOneByOrFail({ id: a.id }),
      dataSource.getRepository(Ride).findOneByOrFail({ id: b.id }),
      dataSource.getRepository(Ride).findOneByOrFail({ id: c.id }),
    ]);

    expect(aAfter.status).toBe(RideStatus.CANCELLED);
    expect(bAfter.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(cAfter.status).toBe(RideStatus.ASSURANCE_PENDING);
  });

  it('CRITICAL: driver no-show of FULL A does not promote C when B is bookable ACTIVE', async () => {
    const { passenger, a, b, c } = await setupFullWithSibling();

    await dataSource.getRepository(Ride).update(a.id, {
      departureDate: '2020-01-01',
      departureTime: '10:00:00',
    });

    await request(app.getHttpServer())
      .post(`/rides/${a.id}/driver-no-show`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    const [aAfter, bAfter, cAfter] = await Promise.all([
      dataSource.getRepository(Ride).findOneByOrFail({ id: a.id }),
      dataSource.getRepository(Ride).findOneByOrFail({ id: b.id }),
      dataSource.getRepository(Ride).findOneByOrFail({ id: c.id }),
    ]);

    expect(aAfter.status).toBe(RideStatus.CANCELLED);
    expect(bAfter.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(cAfter.status).toBe(RideStatus.ASSURANCE_PENDING);
  });

  it('CRITICAL: FORCE skip does not poison a later FORCE with a new operation key', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const d3 = await publishableDriver();

    const active = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureTime: '15:10',
    });
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '15:20',
    });
    const pending2 = await publishAssured(d3.login.accessToken, d3.vehicle.id, {
      departureTime: '15:30',
    });
    expect(pending.status).toBe(RideStatus.ASSURANCE_PENDING);

    const queueId = (
      await dataSource.getRepository(Ride).findOneByOrFail({ id: active.id })
    ).assuredQueueId!;

    const skip = await dataSource.transaction(async (manager) =>
      assuredQueueService.forcePublishInTransaction(
        manager,
        queueId,
        uniqueIdempotencyKey('force-skip'),
      ),
    );
    expect(skip.promotedRide).toBeNull();
    expect(skip.skipped).toBe(true);

    await dataSource.getRepository(Ride).update(active.id, {
      status: RideStatus.CANCELLED,
    });

    const promote = await dataSource.transaction(async (manager) =>
      assuredQueueService.forcePublishInTransaction(
        manager,
        queueId,
        uniqueIdempotencyKey('force-promote'),
      ),
    );
    expect(promote.promotedRide?.id).toBe(pending.id);

    const again = await dataSource.transaction(async (manager) =>
      assuredQueueService.forcePublishInTransaction(
        manager,
        queueId,
        uniqueIdempotencyKey('force-promote-2'),
      ),
    );
    expect(again.promotedRide).toBeNull();
    expect(again.skipped).toBe(true);

    void pending2;
  });

  it('CRITICAL: duplicate successful FORCE with same key is idempotent', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const forceDate = '2026-10-11';

    const active = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureDate: forceDate,
      departureTime: '13:10',
    });
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureDate: forceDate,
      departureTime: '13:40',
    });

    await dataSource.getRepository(Ride).update(active.id, {
      status: RideStatus.CANCELLED,
    });

    const queueId = (
      await dataSource.getRepository(Ride).findOneByOrFail({ id: pending.id })
    ).assuredQueueId!;
    const opKey = uniqueIdempotencyKey('force-dup');

    await dataSource.transaction(async (manager) => {
      const first = await assuredQueueService.forcePublishInTransaction(
        manager,
        queueId,
        opKey,
      );
      const second = await assuredQueueService.forcePublishInTransaction(
        manager,
        queueId,
        opKey,
      );
      expect(first.promotedRide?.id).toBe(pending.id);
      expect(second.alreadyApplied).toBe(true);
      expect(second.promotedRide?.id).toBe(pending.id);
    });
  });

  it('HIGH: concurrent publishes with adjacent destination buckets share one queue', async () => {
    expect(
      buildAssuredQueueDestinationBucket(
        NOIDA.destinationLatitude,
        NOIDA.destinationLongitude,
      ),
    ).not.toBe(
      buildAssuredQueueDestinationBucket(
        NEARBY_DEST.destinationLatitude,
        NEARBY_DEST.destinationLongitude,
      ),
    );

    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    const [r1, r2] = await Promise.all([
      publishAssured(d1.login.accessToken, d1.vehicle.id, {
        departureTime: '16:05',
        ...NOIDA,
      }),
      publishAssured(d2.login.accessToken, d2.vehicle.id, {
        departureTime: '16:10',
        ...NEARBY_DEST,
      }),
    ]);

    const rows = await dataSource.getRepository(Ride).find({
      where: { id: In([r1.id, r2.id]) },
    });
    expect(rows[0].assuredQueueId).toBe(rows[1].assuredQueueId);
    expect(
      rows.filter((row) => row.status === RideStatus.ASSURANCE_ACTIVE),
    ).toHaveLength(1);
    expect(
      rows.filter((row) => row.status === RideStatus.ASSURANCE_PENDING),
    ).toHaveLength(1);
  });

  it('HIGH: admin radius shrink still joins existing snapshotted queue', async () => {
    const defaultKm = await settingsService.getAssuredQueueCorridorRadiusKm();
    expect(defaultKm).toBe(50);

    const d1 = await publishableDriver();
    const first = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureDate: '2026-10-12',
      departureTime: '10:15',
    });
    const firstRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: first.id });
    const queue = await dataSource
      .getRepository(AssuredGeographicQueue)
      .findOneByOrFail({ id: firstRow.assuredQueueId! });
    expect(queue.corridorRadiusMeters).toBe(50_000);

    await settingsService.setAssuredQueueCorridorRadiusKm(20);

    // Point ~35 km before Dehradun on the Noida→Dehradun geodesic (within 50 km snapshot, outside 20 km admin).
    const midLat = 30.0;
    const midLng = 77.918;
    const distToAnchor = haversineMeters(
      { latitude: midLat, longitude: midLng },
      {
        latitude: queue.anchorDestinationLatitude,
        longitude: queue.anchorDestinationLongitude,
      },
    );
    expect(distToAnchor).toBeGreaterThan(20_000);
    expect(distToAnchor).toBeLessThan(50_000);

    const d2 = await publishableDriver();
    const second = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureDate: '2026-10-12',
      departureTime: '10:40',
      source: 'Corridor Mid Hub',
      destination: 'Near Dehradun Mid',
      sourceLatitude: NOIDA.sourceLatitude,
      sourceLongitude: NOIDA.sourceLongitude,
      destinationLatitude: midLat,
      destinationLongitude: midLng,
    });

    const secondRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: second.id });
    expect(secondRow.assuredQueueId).toBe(firstRow.assuredQueueId);
    expect(second.status).toBe(RideStatus.ASSURANCE_PENDING);

    await settingsService.setAssuredQueueCorridorRadiusKm(defaultKm);
  });

  it('HIGH: CHECK rejects Assured ACTIVE/PENDING with NULL assured_queue_id', async () => {
    const d1 = await publishableDriver();
    const ride = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureDate: '2026-10-13',
      departureTime: '09:15',
    });

    await expect(
      dataSource.query(
        `UPDATE rides SET assured_queue_id = NULL WHERE id = $1`,
        [ride.id],
      ),
    ).rejects.toThrow(/CHK_rides_assured_queue_membership|check constraint/i);
  });

  it('MEDIUM: FULL ACTIVE rides are excluded from rider search', async () => {
    const { a, b, passenger } = await setupFullWithSibling();

    const res = await request(app.getHttpServer())
      .get('/rides/search')
      .query({
        source: NOIDA.source,
        destination: NOIDA.destination,
        date: '2026-10-10',
        rideType: RideType.ASSURED,
      })
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    const ids = (res.body.items as Array<{ id: string }>).map((item) => item.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
  });

  it('MEDIUM: requeue acquires queue locks in deterministic UUID order', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureTime: '11:10',
    });
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '11:20',
    });

    // Move pending into a different window/queue.
    await request(app.getHttpServer())
      .patch(`/rides/${pending.id}`)
      .set('Authorization', `Bearer ${d2.login.accessToken}`)
      .send({ departureTime: '18:15' })
      .expect(200);

    const updated = await dataSource.getRepository(Ride).findOneByOrFail({
      id: pending.id,
    });
    expect(updated.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(updated.assuranceWindowStart).toMatch(/^18:/);
  });
});
