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
import { BookingStatus } from '../bookings/enums/booking.enums';
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
import { Ride } from './entities/ride.entity';
import { RideStatus, RideType } from './enums/ride.enums';
import { RidesModule } from './rides.module';

describe('Regular ride modify (PATCH /rides/:id)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
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
        for (const ride of rides) {
          await dataSource.getRepository(Booking).delete({ rideId: ride.id });
        }
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
    await dataSource.getRepository(UserProfile).save(
      dataSource.getRepository(UserProfile).create({
        userId: login.user.id,
        firstName: 'Modify',
        lastName: 'Driver',
        displayName: 'Modify Driver',
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
      .send({
        rideType: RideType.REGULAR,
        vehicleId: vehicle.id,
        source: 'Noida Sector 62',
        destination: 'Connaught Place, Delhi',
        departureDate: '2026-08-20',
        departureTime: '09:00',
        totalSeats,
        pricePerSeat: 250,
        notes: 'AC car',
      })
      .expect(201);

    return { login, vehicle, ride: rideResponse.body };
  }

  async function verifiedPassenger() {
    const login = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);
    return login;
  }

  async function bookSeats(
    passengerToken: string,
    rideId: string,
    seats: number,
  ) {
    return request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passengerToken}`)
      .send({ rideId, seats, paymentMethod: 'PAY_LATER' })
      .expect(201);
  }

  async function bookOneSeatEach(rideId: string, count: number) {
    const passengers = [];
    for (let i = 0; i < count; i += 1) {
      const passenger = await verifiedPassenger();
      await bookSeats(passenger.accessToken, rideId, 1);
      passengers.push(passenger);
    }
    return passengers;
  }

  it('TEST 1: zero bookings allows full Regular ride modification', async () => {
    const { login, ride } = await publishableDriver(4);

    const updated = await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        source: 'Ghaziabad',
        destination: 'Gurgaon',
        departureDate: '2026-08-21',
        departureTime: '10:30',
        pricePerSeat: 300,
        totalSeats: 3,
      })
      .expect(200);

    expect(updated.body).toMatchObject({
      source: 'Ghaziabad',
      destination: 'Gurgaon',
      departureDate: '2026-08-21',
      totalSeats: 3,
      availableSeats: 3,
      pricePerSeat: '300',
    });
    expect(updated.body.departureTime).toMatch(/^10:30/);
  });

  it('TEST 2: 4 seats / 1 booked seat — can reduce to 1, not 0', async () => {
    const { login, ride } = await publishableDriver(4);
    await bookOneSeatEach(ride.id, 1);

    const ok = await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ totalSeats: 1 })
      .expect(200);
    expect(ok.body.totalSeats).toBe(1);
    expect(ok.body.availableSeats).toBe(0);

    await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ totalSeats: 0 })
      .expect(400);
  });

  it('TEST 3: 4 seats / 2 booked seats — can reduce to 2, not 1', async () => {
    const { login, ride } = await publishableDriver(4);
    await bookOneSeatEach(ride.id, 2);

    const ok = await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ totalSeats: 2 })
      .expect(200);
    expect(ok.body.totalSeats).toBe(2);
    expect(ok.body.availableSeats).toBe(0);

    await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ totalSeats: 1 })
      .expect(400);
  });

  it('TEST 4: 4 seats / 3 booked seats — can reduce to 3, not 2', async () => {
    const { login, ride } = await publishableDriver(4);
    await bookOneSeatEach(ride.id, 3);

    const ok = await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ totalSeats: 3 })
      .expect(200);
    expect(ok.body.totalSeats).toBe(3);

    await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ totalSeats: 2 })
      .expect(400);
  });

  it('TEST 5: 4 seats / 4 booked seats — cannot reduce to 3', async () => {
    const { login, ride } = await publishableDriver(4);
    await bookOneSeatEach(ride.id, 4);

    await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ totalSeats: 3 })
      .expect(400);
  });

  it('TEST 6–10: active bookings block source/destination/date/time/fare changes', async () => {
    const { login, ride } = await publishableDriver(4);
    await bookOneSeatEach(ride.id, 1);
    const auth = { Authorization: `Bearer ${login.accessToken}` };

    await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set(auth)
      .send({ source: 'Somewhere Else' })
      .expect(409);

    await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set(auth)
      .send({ destination: 'Somewhere Else' })
      .expect(409);

    await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set(auth)
      .send({ departureDate: '2026-08-22' })
      .expect(409);

    await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set(auth)
      .send({ departureTime: '11:00' })
      .expect(409);

    await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set(auth)
      .send({ pricePerSeat: 100 })
      .expect(409);

    await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set(auth)
      .send({ totalSeats: 2, pricePerSeat: 100 })
      .expect(409);

    const seatsOnly = await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set(auth)
      .send({ totalSeats: 2 })
      .expect(200);
    expect(seatsOnly.body.totalSeats).toBe(2);
    expect(seatsOnly.body.source).toBe('Noida Sector 62');
  });

  it('TEST 11: cancelled bookings do not block capacity reduction', async () => {
    const { login, ride } = await publishableDriver(4);
    const [passenger] = await bookOneSeatEach(ride.id, 1);

    await dataSource.getRepository(Booking).update(
      { passengerId: passenger.user.id, rideId: ride.id },
      { status: BookingStatus.CANCELLED },
    );

    const updated = await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ totalSeats: 1 })
      .expect(200);
    expect(updated.body.totalSeats).toBe(1);
  });

  it('TEST 12–14: IN_PROGRESS / COMPLETED / CANCELLED Regular rides cannot be modified', async () => {
    const started = await publishableDriver(4);
    await dataSource
      .getRepository(Ride)
      .update({ id: started.ride.id }, { status: RideStatus.IN_PROGRESS });
    await request(app.getHttpServer())
      .patch(`/rides/${started.ride.id}`)
      .set('Authorization', `Bearer ${started.login.accessToken}`)
      .send({ totalSeats: 3 })
      .expect(409);

    const completed = await publishableDriver(4);
    await dataSource
      .getRepository(Ride)
      .update({ id: completed.ride.id }, { status: RideStatus.COMPLETED });
    await request(app.getHttpServer())
      .patch(`/rides/${completed.ride.id}`)
      .set('Authorization', `Bearer ${completed.login.accessToken}`)
      .send({ totalSeats: 3 })
      .expect(409);

    const cancelled = await publishableDriver(4);
    await dataSource
      .getRepository(Ride)
      .update({ id: cancelled.ride.id }, { status: RideStatus.CANCELLED });
    await request(app.getHttpServer())
      .patch(`/rides/${cancelled.ride.id}`)
      .set('Authorization', `Bearer ${cancelled.login.accessToken}`)
      .send({ totalSeats: 3 })
      .expect(409);
  });

  it('TEST 15–16: another driver and a passenger cannot modify the ride', async () => {
    const owner = await publishableDriver(4);
    const otherDriver = await publishableDriver(4);
    const passenger = await verifiedPassenger();

    await request(app.getHttpServer())
      .patch(`/rides/${owner.ride.id}`)
      .set('Authorization', `Bearer ${otherDriver.login.accessToken}`)
      .send({ totalSeats: 3 })
      .expect(404);

    await request(app.getHttpServer())
      .patch(`/rides/${owner.ride.id}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ totalSeats: 3 })
      .expect(404);
  });

  it('TEST 17: concurrent booking is re-checked before reducing seats', async () => {
    const { login, ride } = await publishableDriver(4);
    const passenger = await verifiedPassenger();

    const [bookingResult, patchResult] = await Promise.allSettled([
      request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.accessToken}`)
        .send({ rideId: ride.id, seats: 2, paymentMethod: 'PAY_LATER' }),
      request(app.getHttpServer())
        .patch(`/rides/${ride.id}`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send({ totalSeats: 1 }),
    ]);

    const bookingStatus =
      bookingResult.status === 'fulfilled' ? bookingResult.value.status : 0;
    const patchStatus =
      patchResult.status === 'fulfilled' ? patchResult.value.status : 0;

    const rideRow = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    const active = await dataSource.getRepository(Booking).find({
      where: [
        { rideId: ride.id, status: BookingStatus.PENDING },
        { rideId: ride.id, status: BookingStatus.CONFIRMED },
      ],
    });
    const bookedSeats = active.reduce((sum, row) => sum + row.seats, 0);

    expect(rideRow.totalSeats).toBeGreaterThanOrEqual(bookedSeats);
    expect([200, 400, 409]).toContain(patchStatus);
    expect([201, 409]).toContain(bookingStatus);
    if (bookedSeats >= 2) {
      expect(patchStatus).not.toBe(200);
    }
  });
});
