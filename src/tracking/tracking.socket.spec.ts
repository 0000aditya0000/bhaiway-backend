import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { AddressInfo } from 'net';
import { io, Socket } from 'socket.io-client';
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
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import { rideTrackingKey, rideTrackingRoom, REDIS_CLIENT } from './tracking.constants';
import {
  TRACKING_SERVER_EVENTS,
  TRACKING_SOCKET_EVENTS,
  TRACKING_SOCKET_NAMESPACE,
} from './tracking.events';
import { TrackingModule } from './tracking.module';

function waitForEvent<T>(
  socket: Socket,
  event: string,
  timeoutMs = 8_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function emitAck<T>(
  socket: Socket,
  event: string,
  payload: unknown,
  timeoutMs = 8_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ack on ${event}`));
    }, timeoutMs);
    socket
      .timeout(timeoutMs)
      .emit(event, payload, (err: Error | null, response: T) => {
        clearTimeout(timer);
        if (err) {
          reject(err);
          return;
        }
        resolve(response);
      });
  });
}

describe('Tracking Socket.IO (integration)', () => {
  jest.setTimeout(30_000);

  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let redis: Redis;
  let baseUrl: string;
  const tracked: TestWalletContext[] = [];
  const rideIds: string[] = [];
  const openSockets: Socket[] = [];

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
    app.useWebSocketAdapter(new IoAdapter(app));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    dataSource = moduleRef.get(DataSource);
    authService = moduleRef.get(AuthService);
    verificationService = moduleRef.get(VerificationService);
    vehiclesService = moduleRef.get(VehiclesService);

    redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 3,
    });
    await redis.ping();
  });

  afterEach(async () => {
    while (openSockets.length > 0) {
      const socket = openSockets.pop();
      socket?.disconnect();
    }

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
        source: 'Socket Track A',
        destination: 'Socket Track B',
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
    return login;
  }

  function connectTrackingSocket(accessToken: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = io(`${baseUrl}${TRACKING_SOCKET_NAMESPACE}`, {
        auth: { token: accessToken },
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
      });
      openSockets.push(socket);

      const timer = setTimeout(() => {
        reject(new Error('Socket connect timeout'));
      }, 8_000);

      socket.on('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async function startRideWithPassengers(
    seats = 2,
  ): Promise<{
    driver: Awaited<ReturnType<typeof publishableDriver>>;
    passengers: Awaited<ReturnType<typeof verifiedPassenger>>[];
  }> {
    const driver = await publishableDriver();
    const passengers: Awaited<ReturnType<typeof verifiedPassenger>>[] = [];
    for (let i = 0; i < seats; i += 1) {
      const passenger = await verifiedPassenger();
      await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.accessToken}`)
        .send({
          rideId: driver.ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_LATER,
        })
        .expect(201);
      passengers.push(passenger);
    }

    await request(app.getHttpServer())
      .post(`/rides/${driver.ride.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    return { driver, passengers };
  }

  it('1–2: authenticates driver socket and joins own active ride', async () => {
    const { driver } = await startRideWithPassengers(1);
    const socket = await connectTrackingSocket(driver.login.accessToken);

    const join = await emitAck<{
      ok: boolean;
      room?: string;
      role?: string;
    }>(socket, TRACKING_SOCKET_EVENTS.JOIN, { rideId: driver.ride.id });

    expect(join.ok).toBe(true);
    expect(join.role).toBe('driver');
    expect(join.room).toBe(rideTrackingRoom(driver.ride.id));
  });

  it('rejects unauthenticated socket connections', async () => {
    const socket = io(`${baseUrl}${TRACKING_SOCKET_NAMESPACE}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    openSockets.push(socket);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Unauthenticated socket stayed open')),
        5_000,
      );
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.on('connect_error', done);
      socket.on('disconnect', done);
    });

    expect(socket.connected).toBe(false);
  });

  it('3: driver cannot update another driver ride via socket', async () => {
    const { driver } = await startRideWithPassengers(1);
    const other = await publishableDriver();
    await request(app.getHttpServer())
      .post(`/rides/${other.ride.id}/start`)
      .set('Authorization', `Bearer ${other.login.accessToken}`)
      .expect(200);

    const socket = await connectTrackingSocket(other.login.accessToken);
    const result = await emitAck<{ ok: boolean; error?: string }>(
      socket,
      TRACKING_SOCKET_EVENTS.DRIVER_LOCATION_UPDATE,
      {
        rideId: driver.ride.id,
        latitude: 28.6139,
        longitude: 77.209,
      },
    );
    expect(result.ok).toBe(false);
  });

  it('4–5: passenger can join booked ride; stranger cannot', async () => {
    const { driver, passengers } = await startRideWithPassengers(1);
    const stranger = await verifiedPassenger();

    const passengerSocket = await connectTrackingSocket(
      passengers[0].accessToken,
    );
    const passengerJoin = await emitAck<{ ok: boolean; role?: string }>(
      passengerSocket,
      TRACKING_SOCKET_EVENTS.JOIN,
      { rideId: driver.ride.id },
    );
    expect(passengerJoin.ok).toBe(true);
    expect(passengerJoin.role).toBe('passenger');

    const strangerSocket = await connectTrackingSocket(stranger.accessToken);
    const strangerJoin = await emitAck<{ ok: boolean }>(
      strangerSocket,
      TRACKING_SOCKET_EVENTS.JOIN,
      { rideId: driver.ride.id },
    );
    expect(strangerJoin.ok).toBe(false);
  });

  it('6–9: invalid coords rejected; valid update stored + broadcast to multiple passengers', async () => {
    const { driver, passengers } = await startRideWithPassengers(2);
    const p1 = await connectTrackingSocket(passengers[0].accessToken);
    const p2 = await connectTrackingSocket(passengers[1].accessToken);
    const driverSocket = await connectTrackingSocket(driver.login.accessToken);

    await emitAck(p1, TRACKING_SOCKET_EVENTS.JOIN, {
      rideId: driver.ride.id,
    });
    await emitAck(p2, TRACKING_SOCKET_EVENTS.JOIN, {
      rideId: driver.ride.id,
    });

    const invalid = await emitAck<{ ok: boolean }>(
      driverSocket,
      TRACKING_SOCKET_EVENTS.DRIVER_LOCATION_UPDATE,
      {
        rideId: driver.ride.id,
        latitude: 0,
        longitude: 0,
      },
    );
    expect(invalid.ok).toBe(false);

    const wait1 = waitForEvent<{
      rideId: string;
      driverCoordinate: { latitude: number; longitude: number };
      updatedAt: string;
    }>(p1, TRACKING_SERVER_EVENTS.LOCATION_UPDATED);
    const wait2 = waitForEvent<{
      rideId: string;
      driverCoordinate: { latitude: number };
    }>(p2, TRACKING_SERVER_EVENTS.LOCATION_UPDATED);

    const accepted = await emitAck<{ ok: boolean }>(
      driverSocket,
      TRACKING_SOCKET_EVENTS.DRIVER_LOCATION_UPDATE,
      {
        rideId: driver.ride.id,
        latitude: 28.6139,
        longitude: 77.209,
        timestamp: new Date().toISOString(),
        heading: 125,
        speed: 32,
      },
    );
    expect(accepted.ok).toBe(true);

    const [event1, event2] = await Promise.all([wait1, wait2]);
    expect(event1.rideId).toBe(driver.ride.id);
    expect(event1.driverCoordinate.latitude).toBe(28.6139);
    expect(event1.driverCoordinate.longitude).toBe(77.209);
    expect(event2.driverCoordinate.latitude).toBe(28.6139);

    const raw = await redis.get(rideTrackingKey(driver.ride.id));
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.latitude).toBe(28.6139);
    expect(parsed.heading).toBe(125);
    expect(parsed.speed).toBe(32);
  });

  it('10–11: completed and cancelled rides reject new socket locations', async () => {
    const { driver, passengers } = await startRideWithPassengers(1);
    const booking = await dataSource.getRepository(Booking).findOneByOrFail({
      rideId: driver.ride.id,
    });
    const myBookings = await request(app.getHttpServer())
      .get('/bookings/my')
      .set('Authorization', `Bearer ${passengers[0].accessToken}`)
      .expect(200);
    const otp = myBookings.body[0].pickupOtp;

    await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ otp })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/rides/${driver.ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const driverSocket = await connectTrackingSocket(driver.login.accessToken);
    const afterComplete = await emitAck<{ ok: boolean }>(
      driverSocket,
      TRACKING_SOCKET_EVENTS.DRIVER_LOCATION_UPDATE,
      {
        rideId: driver.ride.id,
        latitude: 28.7,
        longitude: 77.3,
      },
    );
    expect(afterComplete.ok).toBe(false);
    expect(await redis.get(rideTrackingKey(driver.ride.id))).toBeNull();

    // Regular cancel is PUBLISHED-only; simulate cancelled IN_PROGRESS state.
    const cancelled = await startRideWithPassengers(1);
    await dataSource.getRepository(Ride).update(
      { id: cancelled.driver.ride.id },
      { status: RideStatus.CANCELLED },
    );

    const cancelSocket = await connectTrackingSocket(
      cancelled.driver.login.accessToken,
    );
    const afterCancel = await emitAck<{ ok: boolean }>(
      cancelSocket,
      TRACKING_SOCKET_EVENTS.DRIVER_LOCATION_UPDATE,
      {
        rideId: cancelled.driver.ride.id,
        latitude: 28.7,
        longitude: 77.3,
      },
    );
    expect(afterCancel.ok).toBe(false);
  });

  it('13–14: reconnect rejoins room; REST fallback still works', async () => {
    const { driver, passengers } = await startRideWithPassengers(1);
    const passengerToken = passengers[0].accessToken;

    let socket = await connectTrackingSocket(passengerToken);
    await emitAck(socket, TRACKING_SOCKET_EVENTS.JOIN, {
      rideId: driver.ride.id,
    });
    socket.disconnect();

    socket = await connectTrackingSocket(passengerToken);
    const rejoin = await emitAck<{ ok: boolean }>(
      socket,
      TRACKING_SOCKET_EVENTS.JOIN,
      { rideId: driver.ride.id },
    );
    expect(rejoin.ok).toBe(true);

    await request(app.getHttpServer())
      .post(`/tracking/rides/${driver.ride.id}/location`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        latitude: 28.55,
        longitude: 77.15,
        timestamp: new Date().toISOString(),
      })
      .expect(200);

    const rest = await request(app.getHttpServer())
      .get(`/tracking/rides/${driver.ride.id}`)
      .set('Authorization', `Bearer ${passengerToken}`)
      .expect(200);

    expect(rest.body.rideStatus).toBe(RideStatus.IN_PROGRESS);
    expect(rest.body.driverCoordinate).toMatchObject({
      latitude: 28.55,
      longitude: 77.15,
    });
    expect(rest.body.isStale).toBe(false);

    const next = waitForEvent(socket, TRACKING_SERVER_EVENTS.LOCATION_UPDATED);
    await new Promise((r) => setTimeout(r, 1_100));
    await request(app.getHttpServer())
      .post(`/tracking/rides/${driver.ride.id}/location`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        latitude: 28.56,
        longitude: 77.16,
        timestamp: new Date().toISOString(),
      })
      .expect(200);

    const event = (await next) as {
      driverCoordinate: { latitude: number };
    };
    expect(event.driverCoordinate.latitude).toBe(28.56);
  });

  it('15–16: complete clears Redis and emits ride:tracking:ended; cancel clears from PUBLISHED', async () => {
    const { driver, passengers } = await startRideWithPassengers(1);
    const passengerSocket = await connectTrackingSocket(
      passengers[0].accessToken,
    );
    await emitAck(passengerSocket, TRACKING_SOCKET_EVENTS.JOIN, {
      rideId: driver.ride.id,
    });

    await request(app.getHttpServer())
      .post(`/tracking/rides/${driver.ride.id}/location`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ latitude: 28.61, longitude: 77.2 })
      .expect(200);

    const booking = await dataSource.getRepository(Booking).findOneByOrFail({
      rideId: driver.ride.id,
    });
    const otp = (
      await request(app.getHttpServer())
        .get('/bookings/my')
        .set('Authorization', `Bearer ${passengers[0].accessToken}`)
        .expect(200)
    ).body[0].pickupOtp;

    await request(app.getHttpServer())
      .post(`/bookings/${booking.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ otp })
      .expect(200);

    const endedWait = waitForEvent<{ rideId: string; reason?: string }>(
      passengerSocket,
      TRACKING_SERVER_EVENTS.TRACKING_ENDED,
    );

    await request(app.getHttpServer())
      .post(`/rides/${driver.ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const ended = await endedWait;
    expect(ended.rideId).toBe(driver.ride.id);
    expect(ended.reason).toBe('complete');
    expect(await redis.get(rideTrackingKey(driver.ride.id))).toBeNull();

    // Cancel is allowed from PUBLISHED and still clears tracking keys.
    const published = await publishableDriver();
    await request(app.getHttpServer())
      .post(`/tracking/rides/${published.ride.id}/location`)
      .set('Authorization', `Bearer ${published.login.accessToken}`)
      .send({ latitude: 28.5, longitude: 77.1 })
      .expect(409);

    await redis.set(
      rideTrackingKey(published.ride.id),
      JSON.stringify({
        rideId: published.ride.id,
        driverId: published.login.user.id,
        latitude: 28.5,
        longitude: 77.1,
        timestamp: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      'EX',
      120,
    );

    await request(app.getHttpServer())
      .post(`/rides/${published.ride.id}/cancel`)
      .set('Authorization', `Bearer ${published.login.accessToken}`)
      .expect(200);

    expect(await redis.get(rideTrackingKey(published.ride.id))).toBeNull();
  });

  it('12: Redis failure surfaces as unavailable on REST (graceful for clients)', async () => {
    const { driver } = await startRideWithPassengers(1);
    const trackingRedis = moduleRef.get<Redis>(REDIS_CLIENT);
    const setSpy = jest
      .spyOn(trackingRedis, 'set')
      .mockRejectedValueOnce(new Error('forced redis write failure'));

    await request(app.getHttpServer())
      .post(`/tracking/rides/${driver.ride.id}/location`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ latitude: 28.6139, longitude: 77.209 })
      .expect(503);

    setSpy.mockRestore();
  });
});
