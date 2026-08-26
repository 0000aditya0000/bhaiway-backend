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
  BookingPickupStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';
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
import { Ride } from './entities/ride.entity';
import { RideStatus, RideType } from './enums/ride.enums';
import { RidesModule } from './rides.module';

describe('Regular ride trip lifecycle (integration)', () => {
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
  });

  afterEach(async () => {
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        const rides = await dataSource.getRepository(Ride).find({
          where: { driverId: ctx.userId },
        });
        for (const ride of rides) {
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

  async function publishableDriver(totalSeats = 4) {
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
        source: 'Trip Hub',
        destination: 'Trip Dest',
        departureDate: '2026-11-01',
        departureTime: '09:00',
        totalSeats,
        pricePerSeat: 200,
      })
      .expect(201);

    return { login, vehicle, ride: rideResponse.body };
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
      'regular-trip-passenger',
    );
    return login;
  }

  async function bookPayLater(token: string, rideId: string, seats = 1) {
    return request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rideId,
        seats,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);
  }

  it('driver can start own PUBLISHED Regular ride', async () => {
    const { login, ride } = await publishableDriver();

    const started = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(started.body.status).toBe(RideStatus.IN_PROGRESS);

    const row = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(row.status).toBe(RideStatus.IN_PROGRESS);
  });

  it('non-owner cannot start Regular ride', async () => {
    const { ride } = await publishableDriver();
    const other = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(404);
  });

  it('cannot start CANCELLED / COMPLETED / already IN_PROGRESS rides', async () => {
    const { login, ride } = await publishableDriver();

    await dataSource
      .getRepository(Ride)
      .update({ id: ride.id }, { status: RideStatus.CANCELLED });
    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(409);

    await dataSource
      .getRepository(Ride)
      .update({ id: ride.id }, { status: RideStatus.COMPLETED });
    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(409);

    await dataSource
      .getRepository(Ride)
      .update({ id: ride.id }, { status: RideStatus.PUBLISHED });
    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(409);
  });

  it('confirmed passenger receives pickup OTP; owner only; driver never sees OTP', async () => {
    const { login: driver, ride } = await publishableDriver();
    const passenger = await verifiedPassenger();
    const other = await verifiedPassenger();

    const booking = await bookPayLater(passenger.accessToken, ride.id);

    expect(booking.body.pickupStatus).toBe(
      BookingPickupStatus.WAITING_FOR_PICKUP,
    );
    expect(booking.body.pickupOtp).toMatch(/^\d{4}$/);
    expect(booking.body.pickupOrder).toBe(1);

    const mine = await request(app.getHttpServer())
      .get('/bookings/my')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(mine.body[0].pickupOtp).toBe(booking.body.pickupOtp);

    const byId = await request(app.getHttpServer())
      .get(`/bookings/${booking.body.id}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(byId.body.pickupOtp).toBe(booking.body.pickupOtp);

    await request(app.getHttpServer())
      .get(`/bookings/${booking.body.id}`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(404);

    const driverList = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .query({ rideId: ride.id })
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(driverList.body.items[0].pickupStatus).toBe(
      BookingPickupStatus.WAITING_FOR_PICKUP,
    );
    expect(driverList.body.items[0]).not.toHaveProperty('pickupOtp');
    expect(JSON.stringify(driverList.body)).not.toContain(booking.body.pickupOtp);
  });

  it('verify pickup OTP success, wrong OTP, idempotent, and auth rules', async () => {
    const { login: driver, ride } = await publishableDriver();
    const otherDriver = await publishableDriver();
    const passenger = await verifiedPassenger();

    const booking = await bookPayLater(passenger.accessToken, ride.id);
    const otp = booking.body.pickupOtp as string;

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ otp })
      .expect(409);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ otp: '0000' })
      .expect(400);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/verify-pickup`)
      .set('Authorization', `Bearer ${otherDriver.login.accessToken}`)
      .send({ otp })
      .expect(404);

    const verified = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ otp })
      .expect(200);

    expect(verified.body).toMatchObject({
      bookingId: booking.body.id,
      pickupStatus: BookingPickupStatus.PICKED_UP,
      alreadyVerified: false,
    });

    const again = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ otp })
      .expect(200);
    expect(again.body.alreadyVerified).toBe(true);

    const after = await request(app.getHttpServer())
      .get(`/bookings/${booking.body.id}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(after.body.pickupStatus).toBe(BookingPickupStatus.PICKED_UP);
    expect(after.body.pickupOtp).toBeNull();
  });

  it('cancelled booking cannot be picked up', async () => {
    const { login: driver, ride } = await publishableDriver();
    const passenger = await verifiedPassenger();
    const booking = await bookPayLater(passenger.accessToken, ride.id);

    await dataSource.getRepository(Booking).update(
      { id: booking.body.id },
      {
        status: BookingStatus.CANCELLED,
        cancellationReason: BookingCancellationReason.RIDER_CANCELLED,
        cancelledAt: new Date(),
      },
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ otp: booking.body.pickupOtp })
      .expect(409);
  });

  it('sequential pickup then complete; cancelled passenger skipped', async () => {
    const { login: driver, ride } = await publishableDriver(4);
    const p1 = await verifiedPassenger();
    const p2 = await verifiedPassenger();
    const p3 = await verifiedPassenger();

    const b1 = await bookPayLater(p1.accessToken, ride.id);
    const b2 = await bookPayLater(p2.accessToken, ride.id);
    const b3 = await bookPayLater(p3.accessToken, ride.id);

    await dataSource.getRepository(Booking).update(
      { id: b2.body.id },
      {
        status: BookingStatus.CANCELLED,
        cancellationReason: BookingCancellationReason.RIDER_CANCELLED,
        cancelledAt: new Date(),
      },
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const queue = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .query({ rideId: ride.id, status: BookingStatus.CONFIRMED })
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(queue.body.items.map((i: { id: string }) => i.id)).toEqual([
      b1.body.id,
      b3.body.id,
    ]);
    expect(queue.body.items[0].pickupOrder).toBe(1);
    expect(queue.body.items[1].pickupOrder).toBe(3);

    for (const booking of [b1, b3]) {
      const otp = (
        await request(app.getHttpServer())
          .get(`/bookings/${booking.body.id}`)
          .set(
            'Authorization',
            `Bearer ${booking === b1 ? p1.accessToken : p3.accessToken}`,
          )
          .expect(200)
      ).body.pickupOtp;

      await request(app.getHttpServer())
        .post(`/bookings/${booking.body.id}/verify-pickup`)
        .set('Authorization', `Bearer ${driver.accessToken}`)
        .send({ otp })
        .expect(200);
    }

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.COMPLETED);

    for (const id of [b1.body.id, b3.body.id]) {
      const row = await dataSource
        .getRepository(Booking)
        .findOneByOrFail({ id });
      expect(row.status).toBe(BookingStatus.COMPLETED);
      expect(row.pickupStatus).toBe(BookingPickupStatus.PICKED_UP);
    }

    const cancelled = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: b2.body.id });
    expect(cancelled.status).toBe(BookingStatus.CANCELLED);
  });

  it('PUBLISHED Regular ride cannot bypass Start Ride; wrong driver cannot complete', async () => {
    const { login: driver, ride } = await publishableDriver();
    const other = await createAuthenticatedUser();
    const passenger = await verifiedPassenger();
    const booking = await bookPayLater(passenger.accessToken, ride.id);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(409);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(409);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ otp: booking.body.pickupOtp })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(404);

    await dataSource
      .getRepository(Ride)
      .update({ id: ride.id }, { status: RideStatus.CANCELLED });
    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(409);
  });
});
