import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { BookingsModule } from '../bookings/bookings.module';
import { Booking } from '../bookings/entities/booking.entity';
import { BookingPaymentMethod } from '../bookings/enums/booking.enums';
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
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  creditTestWalletPoints,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import { TrackingModule } from './tracking.module';
import { rideTrackingKey } from './tracking.constants';

describe('Tracking (integration — Redis)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  let redis: Redis;
  const tracked: TestWalletContext[] = [];
  const rideIds: string[] = [];

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
        TrackingModule,
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

    redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 3,
    });
    await redis.ping();
  });

  afterEach(async () => {
    while (rideIds.length > 0) {
      const id = rideIds.pop();
      if (id) {
        await redis.del(rideTrackingKey(id));
      }
    }

    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        const rides = await dataSource.getRepository(Ride).find({
          where: { driverId: ctx.userId },
        });
        for (const ride of rides) {
          await redis.del(rideTrackingKey(ride.id));
          await dataSource.getRepository(Booking).delete({ rideId: ride.id });
        }
        await dataSource.getRepository(Booking).delete({
          passengerId: ctx.userId,
        });
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
    }
  });

  afterAll(async () => {
    if (redis) {
      await redis.quit();
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

    return login;
  }

  async function markVerified(userId: string, type: VerificationType) {
    await markVerificationVerified(
      verificationService,
      dataSource,
      userId,
      type,
    );
  }

  async function publishableDriver() {
    const login = await createAuthenticatedUser();
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
      .send({
        rideType: RideType.REGULAR,
        vehicleId: vehicle.id,
        source: 'Track A',
        destination: 'Track B',
        departureDate: '2026-12-01',
        departureTime: '09:00',
        totalSeats: 3,
        pricePerSeat: 200,
      })
      .expect(201);

    rideIds.push(rideResponse.body.id);
    return { login, ride: rideResponse.body };
  }

  async function verifiedPassenger() {
    const login = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);
    const wallet = await dataSource.getRepository(Wallet).findOneByOrFail({
      userId: login.user.id,
    });
    await creditTestWalletPoints(
      walletService,
      wallet.id,
      login.user.id,
      10000n,
      'tracking-passenger',
    );
    return login;
  }

  it('driver can post location for own IN_PROGRESS Regular ride; passenger reads same Redis state', async () => {
    const { login: driver, ride } = await publishableDriver();
    const passenger = await verifiedPassenger();

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/tracking/rides/${ride.id}/location`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ latitude: 28.6139, longitude: 77.209 })
      .expect(409);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const posted = await request(app.getHttpServer())
      .post(`/tracking/rides/${ride.id}/location`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({
        latitude: 28.6139,
        longitude: 77.209,
        timestamp: '2026-08-22T18:30:00.000Z',
      })
      .expect(200);

    expect(posted.body).toMatchObject({
      rideId: ride.id,
      rideStatus: RideStatus.IN_PROGRESS,
      driverCoordinate: {
        latitude: 28.6139,
        longitude: 77.209,
        timestamp: '2026-08-22T18:30:00.000Z',
      },
      isStale: false,
    });
    expect(posted.body.updatedAt).toBeTruthy();

    const passengerView = await request(app.getHttpServer())
      .get(`/tracking/rides/${ride.id}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);

    expect(passengerView.body.driverCoordinate).toEqual({
      latitude: 28.6139,
      longitude: 77.209,
      timestamp: '2026-08-22T18:30:00.000Z',
    });
    expect(passengerView.body.isStale).toBe(false);

    const driverView = await request(app.getHttpServer())
      .get(`/tracking/rides/${ride.id}`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
    expect(driverView.body.driverCoordinate.latitude).toBe(28.6139);

    // Redis is the shared store (cross-device).
    const raw = await redis.get(rideTrackingKey(ride.id));
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).latitude).toBe(28.6139);
  });

  it('rejects other driver, unauthorized passenger, invalid coords, and mock zeros', async () => {
    const { login: driver, ride } = await publishableDriver();
    const other = await publishableDriver();
    const stranger = await verifiedPassenger();
    const passenger = await verifiedPassenger();

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/tracking/rides/${ride.id}/location`)
      .set('Authorization', `Bearer ${other.login.accessToken}`)
      .send({ latitude: 28.6, longitude: 77.2 })
      .expect(404);

    await request(app.getHttpServer())
      .get(`/tracking/rides/${ride.id}`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/tracking/rides/${ride.id}/location`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ latitude: 91, longitude: 77.2 })
      .expect(400);

    await request(app.getHttpServer())
      .post(`/tracking/rides/${ride.id}/location`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ latitude: 28.6, longitude: 181 })
      .expect(400);

    await request(app.getHttpServer())
      .post(`/tracking/rides/${ride.id}/location`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ latitude: 0, longitude: 0 })
      .expect(400);
  });

  it('latest location replaces previous; complete clears tracking', async () => {
    const { login: driver, ride } = await publishableDriver();
    const passenger = await verifiedPassenger();

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/tracking/rides/${ride.id}/location`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ latitude: 28.61, longitude: 77.2 })
      .expect(200);

    await new Promise((r) => setTimeout(r, 1_100));

    await request(app.getHttpServer())
      .post(`/tracking/rides/${ride.id}/location`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ latitude: 28.62, longitude: 77.21 })
      .expect(200);

    const view = await request(app.getHttpServer())
      .get(`/tracking/rides/${ride.id}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(view.body.driverCoordinate.latitude).toBe(28.62);
    expect(view.body.driverCoordinate.longitude).toBe(77.21);

    // Atomic SET EX — key must have a positive TTL (not -1 permanent).
    const ttl = await redis.ttl(rideTrackingKey(ride.id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);

    const otp = (
      await request(app.getHttpServer())
        .get('/bookings/my')
        .set('Authorization', `Bearer ${passenger.accessToken}`)
        .expect(200)
    ).body[0].pickupOtp;

    await request(app.getHttpServer())
      .post(`/bookings/${(await dataSource.getRepository(Booking).findOneByOrFail({ rideId: ride.id })).id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ otp })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(await redis.get(rideTrackingKey(ride.id))).toBeNull();

    await request(app.getHttpServer())
      .post(`/tracking/rides/${ride.id}/location`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ latitude: 28.7, longitude: 77.3 })
      .expect(409);

    const after = await request(app.getHttpServer())
      .get(`/tracking/rides/${ride.id}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(after.body.driverCoordinate).toBeNull();
    expect(after.body.isStale).toBe(true);
    expect(after.body.rideStatus).toBe(RideStatus.COMPLETED);
  });

  it('rejects location for cancelled ride; stale when Redis key expired', async () => {
    const { login: driver, ride } = await publishableDriver();
    const passenger = await verifiedPassenger();

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/tracking/rides/${ride.id}/location`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ latitude: 28.5, longitude: 77.1 })
      .expect(200);

    await redis.del(rideTrackingKey(ride.id));

    const stale = await request(app.getHttpServer())
      .get(`/tracking/rides/${ride.id}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(stale.body.driverCoordinate).toBeNull();
    expect(stale.body.isStale).toBe(true);

    await dataSource
      .getRepository(Ride)
      .update({ id: ride.id }, { status: RideStatus.CANCELLED });

    await request(app.getHttpServer())
      .post(`/tracking/rides/${ride.id}/location`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ latitude: 28.5, longitude: 77.1 })
      .expect(409);
  });
});
