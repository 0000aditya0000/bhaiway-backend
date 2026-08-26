import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import request from 'supertest';

import { AssuredQueueService } from './assured-queue.service';
import { AssuredQueueAdvanceReason } from './enums/assured-queue.enums';
import { AssuredGeographicQueue } from './entities/assured-geographic-queue.entity';
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

describe('Assured Geographic Queue Engine V2 (integration)', () => {
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

  const NOIDA_ROUTE = {
    source: 'Noida Geo Hub',
    destination: 'Dehradun Geo Dest',
    sourceLatitude: 28.5355,
    sourceLongitude: 77.391,
    destinationLatitude: 30.3165,
    destinationLongitude: 78.0322,
  };

  const INDIRAPURAM_ROUTE = {
    source: 'Indirapuram Geo Hub',
    destination: 'Dehradun Geo Dest',
    sourceLatitude: 28.6415,
    sourceLongitude: 77.372,
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
    if (app) {
      await app.close();
    }
  });

  async function createAuthenticatedUser(displayName = 'Geo Queue User') {
    const phone = `+91${Array.from({ length: 10 }, () =>
      Math.floor(Math.random() * 10),
    ).join('')}`;
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
        firstName: 'Geo',
        lastName: 'Queue',
        displayName,
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example.com/geo-queue.jpg',
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
        idempotencyKey: uniqueIdempotencyKey('geo-driver'),
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
        idempotencyKey: uniqueIdempotencyKey('geo-passenger'),
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
        departureDate: '2026-08-30',
        departureTime: '13:15',
        totalSeats: 4,
        pricePerSeat: 300,
        maxTwoInBackSeat: true,
        noSmoking: true,
        noPets: true,
        luggageAllowed: true,
        ...NOIDA_ROUTE,
        ...overrides,
      })
      .expect(201);
    return res.body as { id: string; status: RideStatus };
  }

  it('1: Noida and Indirapuram to Dehradun share one geographic queue', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    const first = await publishAssured(d1.login.accessToken, d1.vehicle.id);
    const second = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      ...INDIRAPURAM_ROUTE,
      departureTime: '13:40',
    });

    const rows = await dataSource.getRepository(Ride).find({
      where: { id: In([first.id, second.id]) },
    });
    expect(rows[0].assuredQueueId).toBeTruthy();
    expect(rows[0].assuredQueueId).toBe(rows[1].assuredQueueId);
    expect(first.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(second.status).toBe(RideStatus.ASSURANCE_PENDING);
  });

  it('3: reverse direction creates a different geographic queue', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    const forward = await publishAssured(d1.login.accessToken, d1.vehicle.id);
    const reverse = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      source: 'Dehradun Reverse Hub',
      destination: 'Noida Reverse Hub',
      sourceLatitude: 30.3165,
      sourceLongitude: 78.0322,
      destinationLatitude: 28.5355,
      destinationLongitude: 77.391,
      departureTime: '13:40',
    });

    const rows = await dataSource.getRepository(Ride).find({
      where: { id: In([forward.id, reverse.id]) },
    });
    expect(rows[0].assuredQueueId).not.toBe(rows[1].assuredQueueId);
    expect(reverse.status).toBe(RideStatus.ASSURANCE_ACTIVE);
  });

  it('6–7: different window or date creates different geographic queue', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const d3 = await publishableDriver();

    const morning = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureTime: '13:15',
    });
    const evening = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '17:10',
    });
    const nextDay = await publishAssured(d3.login.accessToken, d3.vehicle.id, {
      departureDate: '2026-08-31',
      departureTime: '13:15',
    });

    const rows = await dataSource.getRepository(Ride).find({
      where: { id: In([morning.id, evening.id, nextDay.id]) },
    });
    const queueIds = rows.map((row) => row.assuredQueueId);
    expect(new Set(queueIds).size).toBe(3);
  });

  it('11: four compatible rides → first ACTIVE, rest PENDING', async () => {
    const drivers = await Promise.all([
      publishableDriver(),
      publishableDriver(),
      publishableDriver(),
      publishableDriver(),
    ]);

    const rides = [];
    for (let i = 0; i < drivers.length; i += 1) {
      rides.push(
        await publishAssured(
          drivers[i].login.accessToken,
          drivers[i].vehicle.id,
          { departureTime: `13:${String(10 + i * 5).padStart(2, '0')}` },
        ),
      );
    }

    const queueId = (
      await dataSource.getRepository(Ride).findOneByOrFail({ id: rides[0].id })
    ).assuredQueueId!;
    const statuses = await dataSource.getRepository(Ride).find({
      where: { assuredQueueId: queueId },
      order: { createdAt: 'ASC' },
    });
    expect(statuses.filter((r) => r.status === RideStatus.ASSURANCE_ACTIVE)).toHaveLength(1);
    expect(statuses.filter((r) => r.status === RideStatus.ASSURANCE_PENDING)).toHaveLength(3);
  });

  it('17–18: concurrent Noida and Indirapuram publish → one queue, one bookable ACTIVE', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();

    const [r1, r2] = await Promise.all([
      publishAssured(d1.login.accessToken, d1.vehicle.id, {
        departureTime: '14:05',
      }),
      publishAssured(d2.login.accessToken, d2.vehicle.id, {
        ...INDIRAPURAM_ROUTE,
        departureTime: '14:10',
      }),
    ]);

    const rows = await dataSource.getRepository(Ride).find({
      where: { id: In([r1.id, r2.id]) },
    });
    expect(rows[0].assuredQueueId).toBe(rows[1].assuredQueueId);
    const activeCount = rows.filter(
      (row) => row.status === RideStatus.ASSURANCE_ACTIVE,
    ).length;
    expect(activeCount).toBe(1);
  });

  it('21–23: admin radius changes affect new queues only', async () => {
    const defaultKm = await settingsService.getAssuredQueueCorridorRadiusKm();
    expect(defaultKm).toBe(50);

    const d1 = await publishableDriver();
    const first = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureDate: '2026-09-01',
      departureTime: '10:15',
    });
    const firstQueue = await dataSource
      .getRepository(AssuredGeographicQueue)
      .findOneByOrFail({ id: (await dataSource.getRepository(Ride).findOneByOrFail({ id: first.id })).assuredQueueId! });
    expect(firstQueue.corridorRadiusMeters).toBe(50_000);

    await settingsService.setAssuredQueueCorridorRadiusKm(30);

    const d2 = await publishableDriver();
    const second = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureDate: '2026-09-02',
      departureTime: '10:15',
      sourceLatitude: 28.5355 + 0.5,
      sourceLongitude: 77.391 + 0.5,
    });
    const secondQueue = await dataSource
      .getRepository(AssuredGeographicQueue)
      .findOneByOrFail({ id: (await dataSource.getRepository(Ride).findOneByOrFail({ id: second.id })).assuredQueueId! });
    expect(secondQueue.corridorRadiusMeters).toBe(30_000);
    expect(firstQueue.corridorRadiusMeters).toBe(50_000);

    await settingsService.setAssuredQueueCorridorRadiusKm(defaultKm);
  });

  it('26: missing geometry cannot enter geographic queue', async () => {
    const driver = await publishableDriver();
    await request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(driver.login.accessToken))
      .send({
        rideType: RideType.ASSURED,
        vehicleId: driver.vehicle.id,
        source: 'Mystery Source',
        destination: 'Mystery Destination',
        departureDate: '2026-08-30',
        departureTime: '13:15',
        totalSeats: 4,
        pricePerSeat: 300,
      })
      .expect(400);
  });

  it('15: FORCE_PUBLISH promotes exactly one eligible PENDING ride', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const forceDate = '2026-09-20';

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

    await dataSource.transaction(async (manager) => {
      const first = await assuredQueueService.forcePublishInTransaction(
        manager,
        queueId,
        `queue-force-op:${queueId}:geo-test-1`,
      );
      const second = await assuredQueueService.forcePublishInTransaction(
        manager,
        queueId,
        `queue-force-op:${queueId}:geo-test-1`,
      );
      expect(first.promotedRide?.id).toBe(pending.id);
      expect(second.alreadyApplied).toBe(true);
    });
  });

  it('19: concurrent FULL promotion is idempotent', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const passenger = await verifiedPassenger(20000n);

    const active = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      totalSeats: 1,
    });
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '13:40',
      totalSeats: 1,
    });

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('geo-full-book'))
      .send({
        rideId: active.id,
        seats: 1,
        paymentMethod: 'ASSURED_DEPOSIT',
      })
      .expect(201);

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
});
