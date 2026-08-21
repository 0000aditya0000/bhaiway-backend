import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import { UserVerification } from '../verification/entities/user-verification.entity';
import {
  VerificationStatus,
  VerificationType,
} from '../verification/enums/verification.enums';
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
import { UserProfile } from '../users/entities/user-profile.entity';
import { BookingsModule } from './bookings.module';
import { BookingsService } from './bookings.service';
import { Booking } from './entities/booking.entity';
import { BookingStatus } from './enums/booking.enums';

describe('BookingsController (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let bookingsService: BookingsService;
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
    bookingsService = moduleRef.get(BookingsService);
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

  async function publishableDriver(
    totalSeats = 3,
    options: {
      displayName?: string | null;
      profilePhoto?: string | null;
      withProfile?: boolean;
    } = {},
  ) {
    const login = await createAuthenticatedUser();

    if (options.withProfile !== false) {
      await dataSource.getRepository(UserProfile).save(
        dataSource.getRepository(UserProfile).create({
          userId: login.user.id,
          firstName: 'Booking',
          lastName: 'Driver',
          displayName:
            options.displayName === undefined
              ? 'Booking Driver'
              : options.displayName,
          gender: null,
          dateOfBirth: null,
          profilePhoto:
            options.profilePhoto === undefined
              ? 'https://cdn.example.com/booking-driver.jpg'
              : options.profilePhoto,
        }),
      );
    }

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

  it('POST /bookings requires JWT', async () => {
    await request(app.getHttpServer())
      .post('/bookings')
      .send({
        rideId: '00000000-0000-4000-8000-000000000001',
        seats: 1,
      })
      .expect(401);
  });

  it('unverified passenger cannot book', async () => {
    const { ride } = await publishableDriver();
    const passenger = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ rideId: ride.id, seats: 1, paymentMethod: 'PAY_LATER' })
      .expect(403);
  });

  it('verified passenger can book successfully', async () => {
    const { ride, login: driver } = await publishableDriver();
    const passenger = await verifiedPassenger();

    const response = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ rideId: ride.id, seats: 2, paymentMethod: 'PAY_LATER' })
      .expect(201);

    expect(response.body).toMatchObject({
      rideId: ride.id,
      passengerId: passenger.user.id,
      seats: 2,
      status: BookingStatus.CONFIRMED,
      paymentMethod: 'PAY_LATER',
      paymentStatus: 'UNPAID',
      pricePerSeatSnapshot: '250',
      totalAmount: '500',
      driver: {
        id: driver.user.id,
        displayName: 'Booking Driver',
        profilePhoto: 'https://cdn.example.com/booking-driver.jpg',
        isVerified: true,
      },
    });
  });

  it('booking responses include safe driver summary consistently', async () => {
    const { ride, login: driver } = await publishableDriver();
    const passenger = await verifiedPassenger();

    const created = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ rideId: ride.id, seats: 1, paymentMethod: 'PAY_LATER' })
      .expect(201);

    expect(created.body.driver).toEqual({
      id: driver.user.id,
      displayName: 'Booking Driver',
      profilePhoto: 'https://cdn.example.com/booking-driver.jpg',
      isVerified: true,
    });
    expect(created.body.driver.phone).toBeUndefined();
    expect(created.body.driver.email).toBeUndefined();
    expect(created.body.driver.walletId).toBeUndefined();
    expect(created.body.driver.aadhaarNumber).toBeUndefined();
    expect(created.body.driver.drivingLicenseNumber).toBeUndefined();
    expect(created.body).not.toHaveProperty('driverId');

    const mine = await request(app.getHttpServer())
      .get('/bookings/my')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);

    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].driver).toEqual(created.body.driver);

    const one = await request(app.getHttpServer())
      .get(`/bookings/${created.body.id}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);

    expect(one.body.driver).toEqual(created.body.driver);
  });

  it('driver.profilePhoto is null when missing; isVerified reflects IDENTITY state', async () => {
    const { ride, login: driver } = await publishableDriver(3, {
      profilePhoto: null,
    });
    const passenger = await verifiedPassenger();

    const created = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ rideId: ride.id, seats: 1, paymentMethod: 'PAY_LATER' })
      .expect(201);

    expect(created.body.driver).toMatchObject({
      id: driver.user.id,
      displayName: 'Booking Driver',
      profilePhoto: null,
      isVerified: true,
    });

    const identity = await dataSource
      .getRepository(UserVerification)
      .findOneByOrFail({
        userId: driver.user.id,
        verificationType: VerificationType.IDENTITY,
        isCurrent: true,
      });
    await verificationService.applyTrustedVerificationDecision(identity.id, {
      status: VerificationStatus.REJECTED,
      rejectionReason: 'Test revoke',
    });

    const mine = await request(app.getHttpServer())
      .get('/bookings/my')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);

    expect(mine.body[0].driver.isVerified).toBe(false);
  });

  it('nonexistent ride rejected', async () => {
    const passenger = await verifiedPassenger();

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: '00000000-0000-4000-8000-000000000099',
        seats: 1,
        paymentMethod: 'PAY_LATER',
      })
      .expect(404);
  });

  it('unpublished/cancelled/completed rides rejected', async () => {
    const { ride } = await publishableDriver();
    const passenger = await verifiedPassenger();

    for (const status of [
      RideStatus.DRAFT,
      RideStatus.CANCELLED,
      RideStatus.COMPLETED,
    ]) {
      await dataSource.getRepository(Ride).update({ id: ride.id }, { status });

      await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.accessToken}`)
        .send({ rideId: ride.id, seats: 1, paymentMethod: 'PAY_LATER' })
        .expect(400);
    }
  });

  it('driver cannot book own ride', async () => {
    const { login, ride } = await publishableDriver();

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ rideId: ride.id, seats: 1, paymentMethod: 'PAY_LATER' })
      .expect(403);
  });

  it('passenger cannot supply passengerId / status / amounts', async () => {
    const { ride } = await publishableDriver();
    const passenger = await verifiedPassenger();
    const other = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        passengerId: other.user.id,
        paymentMethod: 'PAY_LATER',
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        status: BookingStatus.CANCELLED,
        totalAmount: '1',
        pricePerSeatSnapshot: '1',
        availableSeats: 99,
        paymentStatus: 'PAID',
        paymentMethod: 'PAY_LATER',
      })
      .expect(400);
  });

  it('invalid rideId and seats rejected', async () => {
    const passenger = await verifiedPassenger();

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ rideId: 'bad', seats: 1, paymentMethod: 'PAY_LATER' })
      .expect(400);

    const { ride } = await publishableDriver();
    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ rideId: ride.id, seats: 0, paymentMethod: 'PAY_LATER' })
      .expect(400);
  });

  it('insufficient seats rejected and availableSeats decreases correctly', async () => {
    const { ride } = await publishableDriver(2);
    const passenger = await verifiedPassenger();

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ rideId: ride.id, seats: 3, paymentMethod: 'PAY_LATER' })
      .expect(409);

    const created = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ rideId: ride.id, seats: 2, paymentMethod: 'PAY_LATER' })
      .expect(201);

    expect(created.body.status).toBe(BookingStatus.CONFIRMED);

    const rideRow = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(rideRow.availableSeats).toBe(0);
  });

  it('price snapshot stored and survives ride price change', async () => {
    const { login, ride } = await publishableDriver();
    const passenger = await verifiedPassenger();

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ rideId: ride.id, seats: 2, paymentMethod: 'PAY_LATER' })
      .expect(201);

    expect(booking.body.pricePerSeatSnapshot).toBe('250');
    expect(booking.body.totalAmount).toBe('500');

    await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ pricePerSeat: 999 })
      .expect(200);

    const row = await dataSource.getRepository(Booking).findOneByOrFail({
      id: booking.body.id,
    });
    expect(row.pricePerSeatSnapshot).toBe('250');
    expect(row.totalAmount).toBe('500');
  });

  it('GET /bookings/my returns only current user bookings', async () => {
    const { ride } = await publishableDriver();
    const passengerA = await verifiedPassenger();
    const passengerB = await verifiedPassenger();

    const bookingA = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passengerA.accessToken}`)
      .send({ rideId: ride.id, seats: 1, paymentMethod: 'PAY_LATER' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passengerB.accessToken}`)
      .send({ rideId: ride.id, seats: 1, paymentMethod: 'PAY_LATER' })
      .expect(201);

    const mine = await request(app.getHttpServer())
      .get('/bookings/my')
      .set('Authorization', `Bearer ${passengerA.accessToken}`)
      .expect(200);

    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].id).toBe(bookingA.body.id);
    expect(mine.body[0].ride.source).toBe('Noida Sector 62');
  });

  it('GET another user booking rejected', async () => {
    const { ride } = await publishableDriver();
    const passengerA = await verifiedPassenger();
    const passengerB = await verifiedPassenger();

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passengerA.accessToken}`)
      .send({ rideId: ride.id, seats: 1, paymentMethod: 'PAY_LATER' })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/bookings/${booking.body.id}`)
      .set('Authorization', `Bearer ${passengerB.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .get(`/bookings/${booking.body.id}`)
      .set('Authorization', `Bearer ${passengerA.accessToken}`)
      .expect(200);
  });

  it('duplicate active booking rejected; cancelled can be rebooked', async () => {
    const { ride } = await publishableDriver(4);
    const passenger = await verifiedPassenger();

    const first = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ rideId: ride.id, seats: 1, paymentMethod: 'PAY_LATER' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ rideId: ride.id, seats: 1, paymentMethod: 'PAY_LATER' })
      .expect(409);

    await dataSource.getRepository(Booking).update(
      { id: first.body.id },
      { status: BookingStatus.CANCELLED },
    );
    await dataSource.getRepository(Ride).increment(
      { id: ride.id },
      'availableSeats',
      1,
    );

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ rideId: ride.id, seats: 1, paymentMethod: 'PAY_LATER' })
      .expect(201);
  });

  it('concurrent bookings cannot overbook', async () => {
    const { ride } = await publishableDriver(2);
    const passengerA = await verifiedPassenger();
    const passengerB = await verifiedPassenger();

    const results = await Promise.allSettled([
      bookingsService.create(passengerA.user.id, {
        rideId: ride.id,
        seats: 2,
        paymentMethod: 'PAY_LATER' as const,
      }),
      bookingsService.create(passengerB.user.id, {
        rideId: ride.id,
        seats: 1,
        paymentMethod: 'PAY_LATER' as const,
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rideRow = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(rideRow.availableSeats).toBe(0);
    expect(rideRow.availableSeats).toBeGreaterThanOrEqual(0);

    const confirmed = await dataSource.getRepository(Booking).find({
      where: { rideId: ride.id, status: BookingStatus.CONFIRMED },
    });
    const bookedSeats = confirmed.reduce(
      (sum, booking) => sum + booking.seats,
      0,
    );
    expect(bookedSeats).toBe(2);
    expect(bookedSeats).toBeLessThanOrEqual(rideRow.totalSeats);
  });

  it('transaction rollback restores ride seats if booking creation fails', async () => {
    const { ride } = await publishableDriver(3);
    const passenger = await verifiedPassenger();

    const before = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });

    const originalSave = Repository.prototype.save;
    const spy = jest
      .spyOn(Repository.prototype, 'save')
      .mockImplementation(async function (this: Repository<unknown>, entity: unknown, ...rest: unknown[]) {
        const maybeBooking = entity as { passengerId?: string; rideId?: string; pricePerSeatSnapshot?: string };
        if (
          maybeBooking &&
          typeof maybeBooking === 'object' &&
          maybeBooking.passengerId &&
          maybeBooking.rideId &&
          maybeBooking.pricePerSeatSnapshot
        ) {
          throw new Error('forced booking failure');
        }
        return originalSave.apply(this, [entity, ...rest] as never);
      });

    try {
      await expect(
        bookingsService.create(passenger.user.id, {
          rideId: ride.id,
          seats: 2,
          paymentMethod: 'PAY_LATER' as const,
        }),
      ).rejects.toThrow('forced booking failure');
    } finally {
      spy.mockRestore();
    }

    const after = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(after.availableSeats).toBe(before.availableSeats);

    const bookings = await dataSource.getRepository(Booking).count({
      where: { rideId: ride.id },
    });
    expect(bookings).toBe(0);
  });
});
