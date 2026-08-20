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
import { Ride } from '../rides/entities/ride.entity';
import { RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import { UserProfile } from '../users/entities/user-profile.entity';
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
import { WalletHold } from '../wallet/entities/wallet-hold.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';
import { BookingsModule } from './bookings.module';
import { Booking } from './entities/booking.entity';
import {
  BookingPaymentMethod,
  BookingStatus,
} from './enums/booking.enums';

describe('BookingsController driver my-rides (integration)', () => {
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

  async function fundWallet(userId: string, amount: string) {
    const wallet = await dataSource.getRepository(Wallet).findOneByOrFail({
      userId,
    });
    await walletService.creditPoints({
      walletId: wallet.id,
      userId,
      amount,
      sourceType: WalletPointSource.PURCHASED,
      referenceType: 'TEST_TOPUP',
      referenceId: `driver-bookings-${userId}-${Date.now()}`,
      idempotencyKey: `test:driver-bookings:topup:${userId}:${Date.now()}:${Math.random()}`,
    });
  }

  async function publishableDriver(
    options: {
      totalSeats?: number;
      rideType?: RideType;
      departureDate?: string;
      departureTime?: string;
      source?: string;
      destination?: string;
      pricePerSeat?: number;
    } = {},
  ) {
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

    if (options.rideType === RideType.ASSURED) {
      await fundWallet(login.user.id, '50000');
    }

    const rideResponse = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        rideType: options.rideType ?? RideType.REGULAR,
        vehicleId: vehicle.id,
        source: options.source ?? 'Noida Sector 62',
        destination: options.destination ?? 'Connaught Place, Delhi',
        departureDate: options.departureDate ?? '2026-08-20',
        departureTime: options.departureTime ?? '09:00',
        totalSeats: options.totalSeats ?? 3,
        pricePerSeat: options.pricePerSeat ?? 250,
        notes: 'AC car',
      })
      .expect(201);

    return { login, vehicle, ride: rideResponse.body };
  }

  async function verifiedPassenger(withProfile = false) {
    const login = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);
    if (withProfile) {
      await dataSource.getRepository(UserProfile).save(
        dataSource.getRepository(UserProfile).create({
          userId: login.user.id,
          firstName: 'Priya',
          lastName: 'Sharma',
          displayName: 'Priya S',
          profilePhoto: 'https://cdn.example.com/priya.jpg',
        }),
      );
    }
    return login;
  }

  async function bookPayLater(
    passengerToken: string,
    rideId: string,
    seats = 1,
  ) {
    return request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passengerToken}`)
      .send({
        rideId,
        seats,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);
  }

  function assertSafeDriverBookingShape(item: Record<string, unknown>) {
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('rideId');
    expect(item).toHaveProperty('passenger');
    expect(item).toHaveProperty('seats');
    expect(item).toHaveProperty('status');
    expect(item).toHaveProperty('bookingMode');
    expect(item).toHaveProperty('paymentMethod');
    expect(item).toHaveProperty('paymentStatus');
    expect(item).toHaveProperty('pricePerSeatSnapshot');
    expect(item).toHaveProperty('totalAmount');
    expect(item).toHaveProperty('ride');
    expect(item).toHaveProperty('createdAt');
    expect(item).toHaveProperty('updatedAt');

    const forbidden = [
      'walletHoldId',
      'wallet_hold_id',
      'driverDepositHoldId',
      'driver_deposit_hold_id',
      'walletTransactionId',
      'wallet_transaction_id',
      'walletId',
      'assuredDepositAmount',
      'securityDepositAmount',
      'securityDepositPercentage',
      'idempotencyKey',
      'phone',
      'email',
      'password',
      'aadhaar',
      'documentUrl',
      'documentReference',
    ];
    for (const key of forbidden) {
      expect(item).not.toHaveProperty(key);
    }

    const passenger = item.passenger as Record<string, unknown>;
    expect(passenger).toEqual(
      expect.objectContaining({
        id: expect.any(String),
      }),
    );
    for (const key of [
      'phone',
      'email',
      'walletId',
      'password',
      'dateOfBirth',
      'gender',
    ]) {
      expect(passenger).not.toHaveProperty(key);
    }

    const ride = item.ride as Record<string, unknown>;
    expect(ride).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        source: expect.any(String),
        destination: expect.any(String),
        departureDate: expect.any(String),
        departureTime: expect.any(String),
        rideType: expect.any(String),
        status: expect.any(String),
      }),
    );
    for (const key of [
      'driverDepositHoldId',
      'assuredDepositAmount',
      'walletHoldId',
      'pricePerSeat',
    ]) {
      expect(ride).not.toHaveProperty(key);
    }
  }

  it('requires JWT', async () => {
    await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .expect(401);
  });

  it('driver with no rides gets empty page', async () => {
    const driver = await createAuthenticatedUser();

    const response = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(response.body).toEqual({
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
    });
  });

  it('driver sees bookings for own rides with safe passenger/ride fields', async () => {
    const { login: driver, ride } = await publishableDriver();
    const passenger = await verifiedPassenger(true);
    const booking = await bookPayLater(passenger.accessToken, ride.id, 2);

    const response = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(response.body.total).toBe(1);
    expect(response.body.items).toHaveLength(1);
    assertSafeDriverBookingShape(response.body.items[0]);
    expect(response.body.items[0]).toMatchObject({
      id: booking.body.id,
      rideId: ride.id,
      seats: 2,
      status: BookingStatus.CONFIRMED,
      bookingMode: 'REGULAR',
      paymentMethod: 'PAY_LATER',
      paymentStatus: 'UNPAID',
      pricePerSeatSnapshot: '250',
      totalAmount: '500',
      passenger: {
        id: passenger.user.id,
        firstName: 'Priya',
        lastName: 'Sharma',
        displayName: 'Priya S',
        profilePhoto: 'https://cdn.example.com/priya.jpg',
      },
      ride: {
        id: ride.id,
        source: ride.source,
        destination: ride.destination,
        rideType: RideType.REGULAR,
      },
    });
  });

  it('excludes another driver bookings; passenger without rides sees empty', async () => {
    const { login: driverA, ride: rideA } = await publishableDriver({
      source: 'Driver A Hub',
    });
    const { login: driverB, ride: rideB } = await publishableDriver({
      source: 'Driver B Hub',
      departureTime: '10:00',
    });
    const passenger = await verifiedPassenger(true);

    const bookingA = await bookPayLater(passenger.accessToken, rideA.id, 1);
    const bookingB = await bookPayLater(passenger.accessToken, rideB.id, 1);

    const listA = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .set('Authorization', `Bearer ${driverA.accessToken}`)
      .expect(200);
    expect(listA.body.total).toBe(1);
    expect(listA.body.items.map((i: { id: string }) => i.id)).toEqual([
      bookingA.body.id,
    ]);

    const listB = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .set('Authorization', `Bearer ${driverB.accessToken}`)
      .expect(200);
    expect(listB.body.total).toBe(1);
    expect(listB.body.items.map((i: { id: string }) => i.id)).toEqual([
      bookingB.body.id,
    ]);

    const listPassenger = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(listPassenger.body).toEqual({
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
    });
  });

  it('rejects client driverId override and includes bookings across multiple own rides', async () => {
    const { login: driver, ride: ride1 } = await publishableDriver({
      departureTime: '08:00',
    });
    const vehicle = await dataSource.getRepository(Vehicle).findOneByOrFail({
      userId: driver.user.id,
    });
    const ride2 = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({
        rideType: RideType.REGULAR,
        vehicleId: vehicle.id,
        source: 'Ghaziabad',
        destination: 'Delhi Airport',
        departureDate: '2026-08-21',
        departureTime: '11:00',
        totalSeats: 3,
        pricePerSeat: 300,
      })
      .expect(201);

    const p1 = await verifiedPassenger();
    const p2 = await verifiedPassenger();
    const b1 = await bookPayLater(p1.accessToken, ride1.id, 1);
    const b2 = await bookPayLater(p2.accessToken, ride2.body.id, 1);

    await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .query({ driverId: p1.user.id })
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(400);

    const list = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(list.body.total).toBe(2);
    const ids = list.body.items.map((i: { id: string }) => i.id).sort();
    expect(ids).toEqual([b1.body.id, b2.body.id].sort());
  });

  it('rideId filter and foreign rideId do not leak', async () => {
    const { login: driverA, ride: rideA } = await publishableDriver();
    const { login: driverB, ride: rideB } = await publishableDriver({
      departureTime: '12:00',
    });
    const passenger = await verifiedPassenger();
    const bookingA = await bookPayLater(passenger.accessToken, rideA.id, 1);
    await bookPayLater(passenger.accessToken, rideB.id, 1);

    const filtered = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .query({ rideId: rideA.id })
      .set('Authorization', `Bearer ${driverA.accessToken}`)
      .expect(200);
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.items[0].id).toBe(bookingA.body.id);

    await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .query({ rideId: rideB.id })
      .set('Authorization', `Bearer ${driverA.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .query({ rideId: rideA.id })
      .set('Authorization', `Bearer ${driverB.accessToken}`)
      .expect(404);
  });

  it('status filter includes cancelled when requested; default returns all', async () => {
    const { login: driver, ride } = await publishableDriver({ totalSeats: 4 });
    const passenger = await verifiedPassenger();
    const active = await bookPayLater(passenger.accessToken, ride.id, 1);

    const passenger2 = await verifiedPassenger();
    const toCancel = await bookPayLater(passenger2.accessToken, ride.id, 1);
    await dataSource.getRepository(Booking).update(
      { id: toCancel.body.id },
      { status: BookingStatus.CANCELLED },
    );

    const all = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
    expect(all.body.total).toBe(2);

    const cancelled = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .query({ status: BookingStatus.CANCELLED })
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
    expect(cancelled.body.total).toBe(1);
    expect(cancelled.body.items[0].id).toBe(toCancel.body.id);

    const confirmed = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .query({ status: BookingStatus.CONFIRMED })
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
    expect(confirmed.body.total).toBe(1);
    expect(confirmed.body.items[0].id).toBe(active.body.id);
  });

  it('pagination and deterministic ordering (created_at DESC, id DESC)', async () => {
    const { login: driver, ride } = await publishableDriver({ totalSeats: 5 });
    const bookings = [];
    for (let i = 0; i < 3; i += 1) {
      const passenger = await verifiedPassenger();
      const created = await bookPayLater(passenger.accessToken, ride.id, 1);
      bookings.push(created.body);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    const page1 = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .query({ page: 1, limit: 2 })
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(page1.body.page).toBe(1);
    expect(page1.body.limit).toBe(2);
    expect(page1.body.total).toBe(3);
    expect(page1.body.totalPages).toBe(2);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.items[0].id).toBe(bookings[2].id);
    expect(page1.body.items[1].id).toBe(bookings[1].id);

    const page2 = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .query({ page: 2, limit: 2 })
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].id).toBe(bookings[0].id);

    await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .query({ limit: 51 })
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(400);
  });

  it('is read-only: no wallet/hold/seat/booking mutations', async () => {
    const { login: driver, ride } = await publishableDriver();
    const passenger = await verifiedPassenger();
    const booking = await bookPayLater(passenger.accessToken, ride.id, 1);

    const beforeTx = await dataSource.getRepository(WalletTransaction).count();
    const beforeHolds = await dataSource.getRepository(WalletHold).count();
    const beforeBooking = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    const beforeRide = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });

    await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const afterTx = await dataSource.getRepository(WalletTransaction).count();
    const afterHolds = await dataSource.getRepository(WalletHold).count();
    const afterBooking = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    const afterRide = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });

    expect(afterTx).toBe(beforeTx);
    expect(afterHolds).toBe(beforeHolds);
    expect(afterBooking.status).toBe(beforeBooking.status);
    expect(afterBooking.updatedAt.toISOString()).toBe(
      beforeBooking.updatedAt.toISOString(),
    );
    expect(afterRide.availableSeats).toBe(beforeRide.availableSeats);
    expect(afterRide.status).toBe(beforeRide.status);
  });

  it('Assured booking appears without exposing hold/deposit internals', async () => {
    const { login: driver, ride } = await publishableDriver({
      rideType: RideType.ASSURED,
      totalSeats: 3,
      pricePerSeat: 500,
    });
    const passenger = await verifiedPassenger(true);
    await fundWallet(passenger.user.id, '50000');

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .set('Idempotency-Key', `assured-driver-list-${Date.now()}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      })
      .expect(201);

    expect(booking.body.bookingMode).toBe('ASSURED');

    const list = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(list.body.total).toBe(1);
    assertSafeDriverBookingShape(list.body.items[0]);
    expect(list.body.items[0]).toMatchObject({
      id: booking.body.id,
      bookingMode: 'ASSURED',
      paymentMethod: 'ASSURED_DEPOSIT',
      ride: { rideType: RideType.ASSURED },
    });
  });

  it('Regular booking regression: still listed for owning driver', async () => {
    const { login: driver, ride } = await publishableDriver();
    const passenger = await verifiedPassenger();
    const booking = await bookPayLater(passenger.accessToken, ride.id, 1);

    const list = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(list.body.items[0].id).toBe(booking.body.id);
    expect(list.body.items[0].bookingMode).toBe('REGULAR');
  });
});
