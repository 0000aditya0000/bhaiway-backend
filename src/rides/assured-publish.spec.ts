import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import request from 'supertest';

import { AssuredGeographicQueue } from '../assured/entities/assured-geographic-queue.entity';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { BookingsModule } from '../bookings/bookings.module';
import { Booking } from '../bookings/entities/booking.entity';
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
import {
  WalletHold,
  WalletHoldStatus,
} from '../wallet/entities/wallet-hold.entity';
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
import { Ride } from './entities/ride.entity';
import { RideStatus, RideType } from './enums/ride.enums';
import { RideDirectionsService } from './route/ride-directions.service';
import { RidesModule } from './rides.module';
import {
  ASSURED_TEST_ROUTE,
  withAssuredPublishHeaders,
} from './test/assured-ride-test.helpers';

/**
 * Assured Ride Publish flow cases A–P (queue V2.1 reused; no algorithm changes).
 */
describe('Assured Ride Publish (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  let rideDirectionsService: RideDirectionsService;
  const tracked: TestWalletContext[] = [];

  const BASE_ROUTE = {
    source: 'Publish Source Hub',
    destination: 'Publish Dest Hub',
    ...ASSURED_TEST_ROUTE,
  };

  const OTHER_CORRIDOR = {
    source: 'Other Corridor Source',
    destination: 'Other Corridor Dest',
    sourceLatitude: 19.076,
    sourceLongitude: 72.8777,
    destinationLatitude: 18.5204,
    destinationLongitude: 73.8567,
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
    rideDirectionsService = moduleRef.get(RideDirectionsService);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
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

  async function publishableDriver(credit = 50_000n) {
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
        firstName: 'Publish',
        lastName: 'Driver',
        displayName: 'Publish Driver',
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example.com/publish.jpg',
      }),
    );
    for (const type of [
      VerificationType.IDENTITY,
      VerificationType.DRIVING_LICENSE,
      VerificationType.VEHICLE,
    ]) {
      await markVerificationVerified(
        verificationService,
        dataSource,
        login.user.id,
        type,
      );
    }
    const vehicle = await vehiclesService.create(login.user.id, {
      vehicleType: VehicleType.CAR,
      make: 'Toyota',
      model: 'Innova',
      variant: 'Crysta',
      registrationNumber: `DL01${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10)}`,
      registrationYear: 2023,
      color: 'Silver',
      seatingCapacity: 6,
    });
    if (credit > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: credit,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('pub-driver'),
      });
    }
    return { login, wallet, vehicle };
  }

  async function publishAssured(
    token: string,
    vehicleId: string,
    overrides: Record<string, unknown> = {},
    idempotencyKey?: string,
  ) {
    const res = await request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(token, idempotencyKey))
      .send({
        rideType: RideType.ASSURED,
        vehicleId,
        departureDate: '2026-11-15',
        departureTime: '13:15',
        totalSeats: 4,
        pricePerSeat: 300,
        ...BASE_ROUTE,
        ...overrides,
      })
      .expect(201);
    return res.body as {
      id: string;
      status: RideStatus;
      isBookable: boolean;
      assuranceWindowStart: string | null;
      assuranceWindowEnd: string | null;
      assuredDepositAmount: string;
      availableSeats: number;
      pricePerSeat: string;
    };
  }

  it('A: first Assured ride → ASSURANCE_ACTIVE and bookable', async () => {
    const d = await publishableDriver();
    const ride = await publishAssured(d.login.accessToken, d.vehicle.id);
    expect(ride.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(ride.isBookable).toBe(true);
    expect(ride.assuranceWindowStart).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(ride.assuranceWindowEnd).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(ride).not.toHaveProperty('assuredQueueId');
    expect(ride).not.toHaveProperty('routePolyline');
  });

  it('B: compatible second ride → ASSURANCE_PENDING', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const first = await publishAssured(d1.login.accessToken, d1.vehicle.id);
    const second = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '13:40',
    });
    expect(first.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(second.status).toBe(RideStatus.ASSURANCE_PENDING);
    expect(second.isBookable).toBe(false);

    const rows = await dataSource.getRepository(Ride).find({
      where: { id: In([first.id, second.id]) },
    });
    expect(new Set(rows.map((r) => r.assuredQueueId)).size).toBe(1);
  });

  it('C: different route → separate queue', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const a = await publishAssured(d1.login.accessToken, d1.vehicle.id);
    const b = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      ...OTHER_CORRIDOR,
    });
    expect(a.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(b.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    const rows = await dataSource.getRepository(Ride).find({
      where: { id: In([a.id, b.id]) },
    });
    expect(rows[0].assuredQueueId).not.toBe(rows[1].assuredQueueId);
  });

  it('D: different date → separate queue', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const a = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureDate: '2026-11-16',
    });
    const b = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureDate: '2026-11-17',
    });
    const rows = await dataSource.getRepository(Ride).find({
      where: { id: In([a.id, b.id]) },
    });
    expect(rows[0].assuredQueueId).not.toBe(rows[1].assuredQueueId);
  });

  it('E: different assurance window → separate queue', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    const a = await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureTime: '09:15',
    });
    const b = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '18:15',
    });
    const rows = await dataSource.getRepository(Ride).find({
      where: { id: In([a.id, b.id]) },
    });
    expect(rows[0].assuredQueueId).not.toBe(rows[1].assuredQueueId);
    expect(a.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    expect(b.status).toBe(RideStatus.ASSURANCE_ACTIVE);
  });

  it('F: missing source coordinates → rejected', async () => {
    const d = await publishableDriver();
    await request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(d.login.accessToken))
      .send({
        rideType: RideType.ASSURED,
        vehicleId: d.vehicle.id,
        source: 'No Source Coords',
        destination: 'Has Dest',
        departureDate: '2026-11-15',
        departureTime: '13:15',
        totalSeats: 4,
        pricePerSeat: 300,
        destinationLatitude: 28.6139,
        destinationLongitude: 77.209,
      })
      .expect(400);
  });

  it('G: missing destination coordinates → rejected', async () => {
    const d = await publishableDriver();
    await request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(d.login.accessToken))
      .send({
        rideType: RideType.ASSURED,
        vehicleId: d.vehicle.id,
        source: 'Has Source',
        destination: 'No Dest Coords',
        departureDate: '2026-11-15',
        departureTime: '13:15',
        totalSeats: 4,
        pricePerSeat: 300,
        sourceLatitude: 28.5355,
        sourceLongitude: 77.391,
      })
      .expect(400);
  });

  it('H/I: route geometry failure → rejected; no orphan deposit hold', async () => {
    const d = await publishableDriver();
    const balanceBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: d.wallet.id });

    jest
      .spyOn(rideDirectionsService, 'buildRouteGeometry')
      .mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(d.login.accessToken))
      .send({
        rideType: RideType.ASSURED,
        vehicleId: d.vehicle.id,
        departureDate: '2026-11-15',
        departureTime: '13:15',
        totalSeats: 4,
        pricePerSeat: 300,
        ...BASE_ROUTE,
      })
      .expect(400);

    expect(JSON.stringify(res.body)).toMatch(/route geometry/i);

    const holds = await dataSource.getRepository(WalletHold).find({
      where: { walletId: d.wallet.id, status: WalletHoldStatus.ACTIVE },
    });
    expect(holds).toHaveLength(0);

    const balanceAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: d.wallet.id });
    expect(balanceAfter.availableBalance).toBe(balanceBefore.availableBalance);

    const rides = await dataSource.getRepository(Ride).find({
      where: { driverId: d.login.user.id },
    });
    expect(rides).toHaveLength(0);
  });

  it('J: insufficient deposit/wallet → rejected', async () => {
    const d = await publishableDriver(0n);
    await request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(d.login.accessToken))
      .send({
        rideType: RideType.ASSURED,
        vehicleId: d.vehicle.id,
        departureDate: '2026-11-15',
        departureTime: '13:15',
        totalSeats: 4,
        pricePerSeat: 300,
        ...BASE_ROUTE,
      })
      .expect(422);
  });

  it('K: successful publish persists ride + queue + deposit', async () => {
    const d = await publishableDriver();
    const ride = await publishAssured(d.login.accessToken, d.vehicle.id);
    const row = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(row.assuredQueueId).toBeTruthy();
    expect(row.routePolyline).toBeTruthy();
    expect(row.driverDepositHoldId).toBeTruthy();
    expect(row.publishIdempotencyKey).toBeTruthy();

    const hold = await dataSource.getRepository(WalletHold).findOneByOrFail({
      id: row.driverDepositHoldId!,
    });
    expect(hold.status).toBe(WalletHoldStatus.ACTIVE);
    expect(hold.amount).toBe(row.assuredDepositAmount);
  });

  it('L: publish failure leaves no orphan financial hold', async () => {
    const d = await publishableDriver();
    jest
      .spyOn(rideDirectionsService, 'buildRouteGeometry')
      .mockResolvedValue(null);

    await request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(d.login.accessToken))
      .send({
        rideType: RideType.ASSURED,
        vehicleId: d.vehicle.id,
        departureDate: '2026-11-18',
        departureTime: '10:00',
        totalSeats: 4,
        pricePerSeat: 300,
        ...BASE_ROUTE,
      })
      .expect(400);

    const holds = await dataSource.getRepository(WalletHold).count({
      where: { walletId: d.wallet.id },
    });
    expect(holds).toBe(0);
  });

  it('M: repeated publish with same Idempotency-Key returns same ride', async () => {
    const d = await publishableDriver();
    const key = uniqueIdempotencyKey('pub-replay');
    const first = await publishAssured(
      d.login.accessToken,
      d.vehicle.id,
      {},
      key,
    );
    const second = await publishAssured(
      d.login.accessToken,
      d.vehicle.id,
      {},
      key,
    );
    expect(second.id).toBe(first.id);

    const count = await dataSource.getRepository(Ride).count({
      where: { driverId: d.login.user.id },
    });
    expect(count).toBe(1);

    const holds = await dataSource.getRepository(WalletHold).count({
      where: { walletId: d.wallet.id, status: WalletHoldStatus.ACTIVE },
    });
    expect(holds).toBe(1);
  });

  it('N: PENDING Assured modify can reassign geographic queue', async () => {
    const d1 = await publishableDriver();
    const d2 = await publishableDriver();
    await publishAssured(d1.login.accessToken, d1.vehicle.id, {
      departureTime: '11:10',
    });
    const pending = await publishAssured(d2.login.accessToken, d2.vehicle.id, {
      departureTime: '11:20',
    });
    expect(pending.status).toBe(RideStatus.ASSURANCE_PENDING);

    const before = await dataSource.getRepository(Ride).findOneByOrFail({
      id: pending.id,
    });

    await request(app.getHttpServer())
      .patch(`/rides/${pending.id}`)
      .set('Authorization', `Bearer ${d2.login.accessToken}`)
      .send({ departureTime: '18:15' })
      .expect(200);

    const after = await dataSource.getRepository(Ride).findOneByOrFail({
      id: pending.id,
    });
    expect(after.assuredQueueId).not.toBe(before.assuredQueueId);
    expect(after.status).toBe(RideStatus.ASSURANCE_ACTIVE);
  });

  it('O: ACTIVE Assured modify blocks route/schedule changes', async () => {
    const d = await publishableDriver();
    const active = await publishAssured(d.login.accessToken, d.vehicle.id);

    await request(app.getHttpServer())
      .patch(`/rides/${active.id}`)
      .set('Authorization', `Bearer ${d.login.accessToken}`)
      .send({ departureTime: '18:15' })
      .expect(409);
  });

  it('P: Regular Ride publish remains unchanged (no Assured queue/deposit)', async () => {
    const d = await publishableDriver();
    const res = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${d.login.accessToken}`)
      .send({
        rideType: RideType.REGULAR,
        vehicleId: d.vehicle.id,
        source: 'Regular Source',
        destination: 'Regular Dest',
        departureDate: '2026-11-15',
        departureTime: '08:00',
        totalSeats: 3,
        pricePerSeat: 100,
      })
      .expect(201);

    expect(res.body.status).toBe(RideStatus.PUBLISHED);
    expect(res.body.rideType).toBe(RideType.REGULAR);
    expect(res.body.isBookable).toBe(true);
    expect(res.body.assuranceWindowStart).toBeNull();
    expect(res.body.assuredDepositAmount).toBeNull();

    const row = await dataSource.getRepository(Ride).findOneByOrFail({
      id: res.body.id,
    });
    expect(row.assuredQueueId).toBeNull();
    expect(row.driverDepositHoldId).toBeNull();
    expect(row.publishIdempotencyKey).toBeNull();
  });
});
