import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
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
import { RidesModule } from './rides.module';
import {
  ASSURED_TEST_ROUTE,
  withAssuredPublishHeaders,
} from './test/assured-ride-test.helpers';
import {
  currentCivilDeparture,
  futureCivilDate,
  pastCivilDate,
  pastCivilTimeToday,
} from './test/ride-departure-test.helpers';

describe('Ride publishing rules (integration)', () => {
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
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (!ctx) continue;
      await dataSource.getRepository(Booking).delete({ passengerId: ctx.userId });
      const rides = await dataSource.getRepository(Ride).find({
        where: { driverId: ctx.userId },
      });
      const queueIds = [
        ...new Set(
          rides
            .map((r) => r.assuredQueueId)
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
  });

  afterAll(async () => {
    await app?.close();
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
        firstName: 'Rules',
        lastName: 'Driver',
        displayName: 'Rules Driver',
        gender: null,
        dateOfBirth: null,
        profilePhoto: null,
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
      registrationNumber: `DL09${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10)}`,
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
        idempotencyKey: uniqueIdempotencyKey('rules-driver'),
      });
    }
    return { login, vehicle };
  }

  function baseBody(
    rideType: RideType,
    vehicleId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      rideType,
      vehicleId,
      source: 'Noida Sector 62',
      destination: 'Connaught Place',
      departureDate: futureCivilDate(14),
      departureTime: '18:30:00',
      totalSeats: 3,
      pricePerSeat: 250,
      ...ASSURED_TEST_ROUTE,
      ...overrides,
    };
  }

  describe('future departure validation', () => {
    it.each([
      [RideType.REGULAR, false],
      [RideType.ASSURED, false],
      [RideType.COMMUTE, false],
      [RideType.REGULAR, true],
      [RideType.ASSURED, true],
    ] as const)(
      '%s womenOnly=%s past departure → 422',
      async (rideType, womenOnly) => {
        const { login, vehicle } = await publishableDriver();
        const past = pastCivilTimeToday();
        const req = request(app.getHttpServer())
          .post('/rides')
          .set(
            rideType === RideType.ASSURED
              ? withAssuredPublishHeaders(login.accessToken)
              : { Authorization: `Bearer ${login.accessToken}` },
          )
          .send(
            baseBody(rideType, vehicle.id, {
              ...past,
              womenOnly: rideType === RideType.COMMUTE ? undefined : womenOnly,
            }),
          );
        const res = await req.expect(422);
        expect(res.body.code).toBe('RIDE_DEPARTURE_IN_PAST');
      },
    );

    it('REGULAR equal-to-now departure → 422', async () => {
      const { login, vehicle } = await publishableDriver();
      const current = currentCivilDeparture();
      const res = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send(baseBody(RideType.REGULAR, vehicle.id, current))
        .expect(422);
      expect(res.body.code).toBe('RIDE_DEPARTURE_IN_PAST');
    });

    it('ASSURED equal-to-now departure → 422', async () => {
      const { login, vehicle } = await publishableDriver();
      const current = currentCivilDeparture();
      const res = await request(app.getHttpServer())
        .post('/rides')
        .set(withAssuredPublishHeaders(login.accessToken))
        .send(baseBody(RideType.ASSURED, vehicle.id, current))
        .expect(422);
      expect(res.body.code).toBe('RIDE_DEPARTURE_IN_PAST');
    });

    it.each([RideType.REGULAR, RideType.ASSURED, RideType.COMMUTE] as const)(
      '%s future departure → success',
      async (rideType) => {
        const { login, vehicle } = await publishableDriver();
        const headers =
          rideType === RideType.ASSURED
            ? withAssuredPublishHeaders(login.accessToken)
            : { Authorization: `Bearer ${login.accessToken}` };
        await request(app.getHttpServer())
          .post('/rides')
          .set(headers)
          .send(baseBody(rideType, vehicle.id))
          .expect(201);
      },
    );

    it('women-only REGULAR future departure → success', async () => {
      const { login, vehicle } = await publishableDriver();
      await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send(baseBody(RideType.REGULAR, vehicle.id, { womenOnly: true }))
        .expect(201);
    });

    it('past civil calendar date → 422', async () => {
      const { login, vehicle } = await publishableDriver();
      const res = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send(
          baseBody(RideType.REGULAR, vehicle.id, {
            departureDate: pastCivilDate(3),
            departureTime: '23:59:00',
          }),
        )
        .expect(422);
      expect(res.body.code).toBe('RIDE_DEPARTURE_IN_PAST');
    });
  });

  describe('one active Assured ride per driver', () => {
    it('second Assured publish blocked even for different route/date', async () => {
      const { login, vehicle } = await publishableDriver();
      await request(app.getHttpServer())
        .post('/rides')
        .set(withAssuredPublishHeaders(login.accessToken))
        .send(baseBody(RideType.ASSURED, vehicle.id))
        .expect(201);

      const blocked = await request(app.getHttpServer())
        .post('/rides')
        .set(withAssuredPublishHeaders(login.accessToken))
        .send(
          baseBody(RideType.ASSURED, vehicle.id, {
            source: 'Other Source',
            destination: 'Other Dest',
            departureDate: futureCivilDate(30),
            sourceLatitude: 19.076,
            sourceLongitude: 72.8777,
            destinationLatitude: 18.5204,
            destinationLongitude: 73.8567,
          }),
        )
        .expect(409);
      expect(blocked.body.code).toBe('ACTIVE_ASSURED_RIDE_EXISTS');
    });

    it('different driver can publish their own Assured ride', async () => {
      const a = await publishableDriver();
      const b = await publishableDriver();
      await request(app.getHttpServer())
        .post('/rides')
        .set(withAssuredPublishHeaders(a.login.accessToken))
        .send(baseBody(RideType.ASSURED, a.vehicle.id))
        .expect(201);
      await request(app.getHttpServer())
        .post('/rides')
        .set(withAssuredPublishHeaders(b.login.accessToken))
        .send(baseBody(RideType.ASSURED, b.vehicle.id))
        .expect(201);
    });

    it('COMPLETED Assured ride unlocks a new Assured publish', async () => {
      const { login, vehicle } = await publishableDriver();
      const first = await request(app.getHttpServer())
        .post('/rides')
        .set(withAssuredPublishHeaders(login.accessToken))
        .send(baseBody(RideType.ASSURED, vehicle.id))
        .expect(201);

      await dataSource
        .getRepository(Ride)
        .update({ id: first.body.id }, { status: RideStatus.COMPLETED });

      await request(app.getHttpServer())
        .post('/rides')
        .set(withAssuredPublishHeaders(login.accessToken))
        .send(
          baseBody(RideType.ASSURED, vehicle.id, {
            departureDate: futureCivilDate(21),
          }),
        )
        .expect(201);
    });

    it('CANCELLED Assured ride unlocks a new Assured publish', async () => {
      const { login, vehicle } = await publishableDriver();
      const first = await request(app.getHttpServer())
        .post('/rides')
        .set(withAssuredPublishHeaders(login.accessToken))
        .send(baseBody(RideType.ASSURED, vehicle.id))
        .expect(201);

      await dataSource
        .getRepository(Ride)
        .update({ id: first.body.id }, { status: RideStatus.CANCELLED });

      await request(app.getHttpServer())
        .post('/rides')
        .set(withAssuredPublishHeaders(login.accessToken))
        .send(
          baseBody(RideType.ASSURED, vehicle.id, {
            departureDate: futureCivilDate(22),
          }),
        )
        .expect(201);
    });

    it('concurrent Assured publishes → only one succeeds', async () => {
      const { login, vehicle } = await publishableDriver();
      const body = baseBody(RideType.ASSURED, vehicle.id, {
        departureDate: futureCivilDate(25),
      });
      const [r1, r2] = await Promise.all([
        request(app.getHttpServer())
          .post('/rides')
          .set(withAssuredPublishHeaders(login.accessToken))
          .send(body),
        request(app.getHttpServer())
          .post('/rides')
          .set(withAssuredPublishHeaders(login.accessToken))
          .send({
            ...body,
            departureDate: futureCivilDate(26),
            source: 'Concurrent B',
          }),
      ]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([201, 409]);
      const winner = r1.status === 201 ? r1 : r2;
      const loser = r1.status === 409 ? r1 : r2;
      expect(loser.body.code).toBe('ACTIVE_ASSURED_RIDE_EXISTS');

      const count = await dataSource.getRepository(Ride).count({
        where: {
          driverId: login.user.id,
          rideType: RideType.ASSURED,
          status: RideStatus.ASSURANCE_ACTIVE,
        },
      });
      // One may be PENDING if queue sibling rules apply — still exactly one active-status row.
      const activeCount = await dataSource
        .getRepository(Ride)
        .createQueryBuilder('r')
        .where('r.driver_id = :driverId', { driverId: login.user.id })
        .andWhere('r.ride_type = :type', { type: RideType.ASSURED })
        .andWhere('r.status IN (:...statuses)', {
          statuses: [
            RideStatus.ASSURANCE_PENDING,
            RideStatus.ASSURANCE_ACTIVE,
            RideStatus.IN_PROGRESS,
          ],
        })
        .getCount();
      expect(activeCount).toBe(1);
      expect(winner.body.id).toBeTruthy();
      expect(count + (activeCount - count)).toBeGreaterThanOrEqual(1);
    });

    it('REGULAR rides remain unrestricted while Assured is active', async () => {
      const { login, vehicle } = await publishableDriver();
      await request(app.getHttpServer())
        .post('/rides')
        .set(withAssuredPublishHeaders(login.accessToken))
        .send(baseBody(RideType.ASSURED, vehicle.id))
        .expect(201);

      await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send(baseBody(RideType.REGULAR, vehicle.id))
        .expect(201);
    });
  });
});
