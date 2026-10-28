import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { BookingsModule } from '../bookings/bookings.module';
import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingPaymentMethod,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { deleteChatForBookingIds } from '../chat/test/chat-test.helpers';
import { RatingTask } from '../ratings/entities/rating-task.entity';
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
import { WalletModule } from '../wallet/wallet.module';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletService } from '../wallet/wallet.service';
import { ActiveRideRole } from './dto/active-ride-response.dto';
import { RideSeries } from './entities/ride-series.entity';
import { Ride } from './entities/ride.entity';
import { RideDirection, RideStatus, RideType } from './enums/ride.enums';
import { RidesModule } from './rides.module';
import { futureCivilDate } from './test/ride-departure-test.helpers';
import {
  withAssuredPublishHeaders,
  withAssuredTestRoute,
} from './test/assured-ride-test.helpers';
import {
  mintSelectedRouteToken,
  SELECTED_ROUTE_TEST_ENDPOINTS,
  withSelectedRoute,
} from './test/selected-route-test.helpers';

describe('GET /rides/my-active (integration)', () => {
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
      if (!ctx) {
        continue;
      }
      const asDriverRides = await dataSource.getRepository(Ride).find({
        where: { driverId: ctx.userId },
        select: { id: true },
      });
      const rideIds = asDriverRides.map((ride) => ride.id);
      const bookings = await dataSource.getRepository(Booking).find({
        where:
          rideIds.length > 0
            ? [{ passengerId: ctx.userId }, { rideId: In(rideIds) }]
            : [{ passengerId: ctx.userId }],
        select: { id: true },
      });
      const bookingIds = bookings.map((booking) => booking.id);
      if (rideIds.length > 0) {
        await dataSource
          .getRepository(RatingTask)
          .createQueryBuilder()
          .delete()
          .where('ride_id IN (:...ids)', { ids: rideIds })
          .execute();
      }
      if (bookingIds.length > 0) {
        await dataSource
          .getRepository(RatingTask)
          .createQueryBuilder()
          .delete()
          .where('booking_id IN (:...ids)', { ids: bookingIds })
          .execute();
        await deleteChatForBookingIds(dataSource, bookingIds);
        await dataSource.getRepository(Booking).delete(bookingIds);
      }
      await dataSource.getRepository(Ride).delete({ driverId: ctx.userId });
      await dataSource.getRepository(RideSeries).delete({ driverId: ctx.userId });
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
    await dataSource.getRepository(UserProfile).save(
      dataSource.getRepository(UserProfile).create({
        userId: login.user.id,
        firstName: 'Active',
        lastName: 'User',
        displayName: 'Active User',
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example.com/active.jpg',
      }),
    );
    return { login, wallet };
  }

  async function fundedDriver() {
    const { login, wallet } = await createAuthenticatedUser();
    const vehicle = await vehiclesService.create(login.user.id, {
      vehicleType: VehicleType.CAR,
      make: 'Maruti',
      model: 'Swift',
      variant: 'ZX',
      registrationNumber: `DL05${Date.now().toString().slice(-6)}${Math.floor(
        Math.random() * 10,
      )}`,
      registrationYear: 2023,
      color: 'White',
      seatingCapacity: 5,
    });
    await markVerificationVerified(
      verificationService,
      dataSource,
      login.user.id,
      VerificationType.IDENTITY,
    );
    await markVerificationVerified(
      verificationService,
      dataSource,
      login.user.id,
      VerificationType.DRIVING_LICENSE,
    );
    await markVerificationVerified(
      verificationService,
      dataSource,
      login.user.id,
      VerificationType.VEHICLE,
    );
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: 20000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('active-driver-fund'),
    });
    return { login, vehicle };
  }

  async function fundedPassenger(amount = 5000n) {
    const { login, wallet } = await createAuthenticatedUser();
    await markVerificationVerified(
      verificationService,
      dataSource,
      login.user.id,
      VerificationType.IDENTITY,
    );
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('active-pass-fund'),
    });
    return { login };
  }

  function reverseRouteToken() {
    return mintSelectedRouteToken({
      sourceLatitude: SELECTED_ROUTE_TEST_ENDPOINTS.destinationLatitude,
      sourceLongitude: SELECTED_ROUTE_TEST_ENDPOINTS.destinationLongitude,
      destinationLatitude: SELECTED_ROUTE_TEST_ENDPOINTS.sourceLatitude,
      destinationLongitude: SELECTED_ROUTE_TEST_ENDPOINTS.sourceLongitude,
    });
  }

  async function publishRegular(
    driver: Awaited<ReturnType<typeof fundedDriver>>,
    overrides: Record<string, unknown> = {},
  ) {
    const response = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send(
        withSelectedRoute({
          rideType: RideType.REGULAR,
          vehicleId: driver.vehicle.id,
          source: 'Noida Sector 62',
          destination: 'Connaught Place',
          departureDate: futureCivilDate(10),
          departureTime: '09:00',
          totalSeats: 3,
          pricePerSeat: 150,
          ...overrides,
        }),
      )
      .expect(201);
    return response.body as { id: string; source: string; destination: string };
  }

  async function bookRegular(
    passengerToken: string,
    rideId: string,
    seats = 1,
  ) {
    const response = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passengerToken}`)
      .send({
        rideId,
        seats,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);
    return response.body as {
      id: string;
      totalAmount: string;
      pickupOtp: string | null;
    };
  }

  it('returns an empty items list when the user has no in-progress rides', async () => {
    const { login } = await createAuthenticatedUser();
    const response = await request(app.getHttpServer())
      .get('/rides/my-active')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);
    expect(response.body).toEqual({ items: [] });
  });

  it('driver sees Regular in-progress overview with passenger count and driver-facing fare', async () => {
    const driver = await fundedDriver();
    const passengerA = await fundedPassenger();
    const passengerB = await fundedPassenger();
    const ride = await publishRegular(driver);
    await bookRegular(passengerA.login.accessToken, ride.id);
    await bookRegular(passengerB.login.accessToken, ride.id, 2);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const active = await request(app.getHttpServer())
      .get('/rides/my-active')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    expect(active.body.items).toHaveLength(1);
    expect(active.body.items[0]).toMatchObject({
      rideId: ride.id,
      role: ActiveRideRole.DRIVER,
      rideType: RideType.REGULAR,
      status: RideStatus.IN_PROGRESS,
      source: 'Noida Sector 62',
      destination: 'Connaught Place',
      totalPassengers: 2,
      totalFare: '450',
    });
    expect(active.body.items[0]).not.toHaveProperty('otp');
    expect(active.body.items[0]).not.toHaveProperty('fare');
    expect(JSON.stringify(active.body)).not.toMatch(/"otp":\s*"\d{4}"/);
  });

  it('passenger sees own Regular fare and OTP; another passenger cannot', async () => {
    const driver = await fundedDriver();
    const passengerA = await fundedPassenger();
    const passengerB = await fundedPassenger();
    const ride = await publishRegular(driver);
    const bookingA = await bookRegular(passengerA.login.accessToken, ride.id);
    const bookingB = await bookRegular(passengerB.login.accessToken, ride.id);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const forA = await request(app.getHttpServer())
      .get('/rides/my-active')
      .set('Authorization', `Bearer ${passengerA.login.accessToken}`)
      .expect(200);
    expect(forA.body.items).toHaveLength(1);
    expect(forA.body.items[0]).toMatchObject({
      rideId: ride.id,
      bookingId: bookingA.id,
      role: ActiveRideRole.PASSENGER,
      fare: bookingA.totalAmount,
      source: 'Noida Sector 62',
      destination: 'Connaught Place',
    });
    expect(forA.body.items[0].otp).toMatch(/^\d{4}$/);
    expect(forA.body.items[0].otp).toBe(bookingA.pickupOtp);
    expect(forA.body.items[0]).not.toHaveProperty('totalFare');
    expect(forA.body.items[0]).not.toHaveProperty('totalPassengers');

    const forB = await request(app.getHttpServer())
      .get('/rides/my-active')
      .set('Authorization', `Bearer ${passengerB.login.accessToken}`)
      .expect(200);
    expect(forB.body.items[0].bookingId).toBe(bookingB.id);
    expect(forB.body.items[0].fare).toBe(bookingB.totalAmount);
    expect(forB.body.items[0].otp).toBe(bookingB.pickupOtp);
    expect(forB.body.items[0].otp).not.toBe(forA.body.items[0].otp);

    await request(app.getHttpServer())
      .post(`/bookings/${bookingA.id}/verify-pickup`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ otp: forA.body.items[0].otp })
      .expect(200);

    const afterPickup = await request(app.getHttpServer())
      .get('/rides/my-active')
      .set('Authorization', `Bearer ${passengerA.login.accessToken}`)
      .expect(200);
    expect(afterPickup.body.items[0].otp).toBeNull();
    expect(afterPickup.body.items[0].fare).toBe(bookingA.totalAmount);
  });

  it('excludes pending bookings from passenger count and hides completed or cancelled rides', async () => {
    const driver = await fundedDriver();
    const confirmed = await fundedPassenger();
    const pending = await fundedPassenger();
    const ride = await publishRegular(driver, { totalSeats: 4 });
    await bookRegular(confirmed.login.accessToken, ride.id);

    const commute = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send(
        withSelectedRoute({
          rideType: RideType.COMMUTE,
          vehicleId: driver.vehicle.id,
          source: 'Gurgaon Cyber City',
          destination: 'Noida Sector 62',
          departureDate: futureCivilDate(11),
          departureTime: '08:30',
          totalSeats: 3,
          pricePerSeat: 100,
        }),
      )
      .expect(201);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${pending.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('active-pending'))
      .send({
        rideId: commute.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const beforeAccept = await request(app.getHttpServer())
      .get('/rides/my-active')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(beforeAccept.body.items).toHaveLength(1);
    expect(beforeAccept.body.items[0].rideId).toBe(ride.id);
    expect(beforeAccept.body.items[0].totalPassengers).toBe(1);

    const pendingView = await request(app.getHttpServer())
      .get('/rides/my-active')
      .set('Authorization', `Bearer ${pending.login.accessToken}`)
      .expect(200);
    expect(pendingView.body.items).toEqual([]);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(409);

    await dataSource
      .getRepository(Ride)
      .update({ id: ride.id }, { status: RideStatus.COMPLETED });

    const afterComplete = await request(app.getHttpServer())
      .get('/rides/my-active')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(
      afterComplete.body.items.some(
        (item: { rideId: string }) => item.rideId === ride.id,
      ),
    ).toBe(false);

    await request(app.getHttpServer())
      .post(`/rides/${commute.body.id}/cancel`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const afterCancel = await request(app.getHttpServer())
      .get('/rides/my-active')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(
      afterCancel.body.items.some(
        (item: { rideId: string }) => item.rideId === commute.body.id,
      ),
    ).toBe(false);
  });

  it('driver sees Assured in-progress overview from persisted booking totals', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(8000n);
    const published = await request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(driver.login.accessToken))
      .send(
        withAssuredTestRoute({
          rideType: RideType.ASSURED,
          vehicleId: driver.vehicle.id,
          source: 'Assured Source',
          destination: 'Assured Dest',
          departureDate: futureCivilDate(12),
          departureTime: '10:00',
          totalSeats: 4,
          pricePerSeat: 500,
        }),
      )
      .expect(201);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('active-assured-book'))
      .send({
        rideId: published.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/rides/${published.body.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const active = await request(app.getHttpServer())
      .get('/rides/my-active')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(active.body.items[0]).toMatchObject({
      rideId: published.body.id,
      role: ActiveRideRole.DRIVER,
      rideType: RideType.ASSURED,
      status: RideStatus.IN_PROGRESS,
      source: 'Assured Source',
      destination: 'Assured Dest',
      totalPassengers: 1,
      totalFare: booking.body.totalAmount,
    });
    expect(active.body.items[0]).not.toHaveProperty('otp');
  });

  it('returns Commute outbound and return occurrences and supports multiple active items', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const published = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('active-series'))
      .send(
        withSelectedRoute({
          rideType: RideType.COMMUTE,
          vehicleId: driver.vehicle.id,
          source: 'Gurgaon Cyber City',
          destination: 'Noida Sector 62',
          departureDate: futureCivilDate(14),
          departureTime: '08:30',
          totalSeats: 3,
          pricePerSeat: 100,
          recurring: true,
          returnEnabled: true,
          returnDepartureTime: '18:30',
          returnRouteSelectionToken: reverseRouteToken(),
        }),
      )
      .expect(201);

    const outbound = published.body.series.occurrences.find(
      (item: { direction: string }) => item.direction === RideDirection.OUTBOUND,
    );
    const inbound = published.body.series.occurrences.find(
      (item: { direction: string }) => item.direction === RideDirection.RETURN,
    );

    const bookOut = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('active-out-book'))
      .send({
        rideId: outbound.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/bookings/${bookOut.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const bookIn = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('active-in-book'))
      .send({
        rideId: inbound.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/bookings/${bookIn.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/rides/${outbound.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/rides/${inbound.id}/start`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const driverActive = await request(app.getHttpServer())
      .get('/rides/my-active')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(driverActive.body.items).toHaveLength(2);
    const outboundItem = driverActive.body.items.find(
      (item: { rideId: string }) => item.rideId === outbound.id,
    );
    const returnItem = driverActive.body.items.find(
      (item: { rideId: string }) => item.rideId === inbound.id,
    );
    expect(outboundItem).toMatchObject({
      role: ActiveRideRole.DRIVER,
      rideType: RideType.COMMUTE,
      direction: RideDirection.OUTBOUND,
      seriesId: published.body.seriesId,
      totalPassengers: 1,
      totalFare: '100',
      source: 'Gurgaon Cyber City',
      destination: 'Noida Sector 62',
    });
    expect(returnItem).toMatchObject({
      role: ActiveRideRole.DRIVER,
      direction: RideDirection.RETURN,
      totalPassengers: 1,
      totalFare: '100',
      source: 'Noida Sector 62',
      destination: 'Gurgaon Cyber City',
    });

    const passengerActive = await request(app.getHttpServer())
      .get('/rides/my-active')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(passengerActive.body.items).toHaveLength(2);
    expect(
      passengerActive.body.items.every(
        (item: { fare: string; otp: string; role: string }) =>
          item.role === ActiveRideRole.PASSENGER &&
          item.fare === '110' &&
          /^\d{4}$/.test(item.otp),
      ),
    ).toBe(true);

    const stranger = await fundedPassenger();
    const strangerActive = await request(app.getHttpServer())
      .get('/rides/my-active')
      .set('Authorization', `Bearer ${stranger.login.accessToken}`)
      .expect(200);
    expect(strangerActive.body.items).toEqual([]);
  });
});
