import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { BookingsModule } from '../bookings/bookings.module';
import { Booking } from '../bookings/entities/booking.entity';
import { BookingPaymentMethod } from '../bookings/enums/booking.enums';
import { deleteChatForBookingIds } from '../chat/test/chat-test.helpers';
import { toCivilDateString } from '../common/time/ride-timezone';
import { CommuteRewardCampaign } from '../commute-rewards/entities/commute-reward-campaign.entity';
import { CommuteRewardQualifyingTrip } from '../commute-rewards/entities/commute-reward-qualifying-trip.entity';
import { CommuteRewardCampaignStatus } from '../commute-rewards/enums/commute-reward.enums';
import { GstInvoiceJob } from '../invoices/entities/invoice-job.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationType } from '../notifications/enums/notification.enums';
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
import {
  WalletTransaction,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletService } from '../wallet/wallet.service';
import {
  commuteRecurrenceWindow,
  weekdayOfCivilDate,
} from './commute-recurrence';
import { RideSeries } from './entities/ride-series.entity';
import { Ride } from './entities/ride.entity';
import {
  RideDirection,
  RideSeriesStatus,
  RideStatus,
  RideType,
  SeriesScope,
} from './enums/ride.enums';
import { RidesModule } from './rides.module';
import { futureCivilDate } from './test/ride-departure-test.helpers';
import { startRideAndVerifyAllPickups } from './test/ride-trip-test.helpers';
import {
  mintSelectedRouteToken,
  SELECTED_ROUTE_TEST_ENDPOINTS,
  withSelectedRoute,
} from './test/selected-route-test.helpers';

function pickupOtpPepper(): string {
  const secret = process.env.JWT_ACCESS_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new Error('JWT_ACCESS_SECRET is required for pickup OTP tests');
  }
  return secret;
}

describe('Daily Office Commute series (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  const tracked: TestWalletContext[] = [];
  const campaignIds: string[] = [];

  const START_DATE = futureCivilDate(14);

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
            .getRepository(GstInvoiceJob)
            .createQueryBuilder()
            .delete()
            .where('ride_id IN (:...ids)', { ids: rideIds })
            .execute();
          await dataSource
            .getRepository(RatingTask)
            .createQueryBuilder()
            .delete()
            .where('ride_id IN (:...ids)', { ids: rideIds })
            .execute();
          await dataSource
            .getRepository(CommuteRewardQualifyingTrip)
            .createQueryBuilder()
            .delete()
            .where('ride_id IN (:...ids)', { ids: rideIds })
            .execute();
        }
        if (bookingIds.length > 0) {
          await dataSource
            .getRepository(GstInvoiceJob)
            .createQueryBuilder()
            .delete()
            .where('booking_id IN (:...ids)', { ids: bookingIds })
            .execute();
          await dataSource
            .getRepository(RatingTask)
            .createQueryBuilder()
            .delete()
            .where('booking_id IN (:...ids)', { ids: bookingIds })
            .execute();
        }
        await dataSource.getRepository(CommuteRewardQualifyingTrip).delete({
          driverId: ctx.userId,
        });
        await dataSource.getRepository(Notification).delete({
          recipientUserId: ctx.userId,
        });
        await deleteChatForBookingIds(dataSource, bookingIds);
        if (bookingIds.length > 0) {
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
    }
    if (campaignIds.length > 0) {
      const ids = [...campaignIds];
      campaignIds.length = 0;
      await dataSource.getRepository(CommuteRewardQualifyingTrip).delete({
        campaignId: In(ids),
      });
      await dataSource.getRepository(CommuteRewardCampaign).delete(ids);
    }
  });

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
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
        firstName: 'Series',
        lastName: 'Driver',
        displayName: 'Series Driver',
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example.com/driver.jpg',
      }),
    );

    return { login, wallet, balance };
  }

  async function publishableDriver() {
    const { login, wallet } = await createAuthenticatedUser();
    const vehicle = await vehiclesService.create(login.user.id, {
      vehicleType: VehicleType.CAR,
      make: 'Maruti',
      model: 'Swift',
      variant: 'ZX',
      registrationNumber: `DL01${Date.now().toString().slice(-6)}${Math.floor(
        Math.random() * 10,
      )}`,
      registrationYear: 2023,
      color: 'Blue',
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
      amount: 10000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('series-driver-fund'),
    });
    return { login, vehicle };
  }

  async function fundedPassenger() {
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
      amount: 5000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('series-passenger-fund'),
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

  function seriesBody(overrides: Record<string, unknown> = {}) {
    return withSelectedRoute({
      rideType: RideType.COMMUTE,
      source: 'Gurgaon Cyber City',
      destination: 'Noida Sector 62',
      departureDate: START_DATE,
      departureTime: '08:30',
      totalSeats: 3,
      pricePerSeat: 100,
      recurring: true,
      ...overrides,
    });
  }

  async function publishSeries(
    accessToken: string,
    vehicleId: string,
    overrides: Record<string, unknown> = {},
    expectedStatus = 201,
    idempotencyKey = uniqueIdempotencyKey('commute-series'),
  ) {
    return request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(seriesBody({ vehicleId, ...overrides }))
      .expect(expectedStatus);
  }

  it('generates seven outbound occurrences including the publishing date', async () => {
    const { login, vehicle } = await publishableDriver();
    const response = await publishSeries(login.accessToken, vehicle.id);

    const window = commuteRecurrenceWindow(START_DATE);
    expect(response.body.seriesId).toBeTruthy();
    expect(response.body.direction).toBe(RideDirection.OUTBOUND);
    expect(response.body.isOriginalOccurrence).toBe(true);
    expect(response.body.series.startDate).toBe(window.startDate);
    expect(response.body.series.endDate).toBe(window.endDate);
    expect(response.body.series.occurrences).toHaveLength(7);
    expect(
      response.body.series.occurrences.filter(
        (item: { direction: string }) => item.direction === RideDirection.OUTBOUND,
      ),
    ).toHaveLength(7);
    expect(
      new Set(
        response.body.series.occurrences.map(
          (item: { departureDate: string }) => item.departureDate,
        ),
      ).size,
    ).toBe(7);
    expect(
      response.body.series.occurrences.filter(
        (item: { id: string }) => item.id === response.body.id,
      ),
    ).toHaveLength(1);
  });

  it('skips excluded weekdays and rejects excluding the publishing date', async () => {
    const { login, vehicle } = await publishableDriver();
    const skip = weekdayOfCivilDate(futureCivilDate(15));
    const startWeekday = weekdayOfCivilDate(START_DATE);
    const response = await publishSeries(login.accessToken, vehicle.id, {
      excludeWeekdays: [skip, skip],
    });
    expect(
      response.body.series.occurrences.some(
        (item: { departureDate: string }) =>
          weekdayOfCivilDate(item.departureDate) === skip,
      ),
    ).toBe(false);
    expect(response.body.series.occurrences.length).toBeLessThan(7);

    await publishSeries(
      login.accessToken,
      vehicle.id,
      { excludeWeekdays: [startWeekday] },
      400,
    );
  });

  it('requires Idempotency-Key for series publish and rejects REGULAR recurrence', async () => {
    const { login, vehicle } = await publishableDriver();
    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(seriesBody({ vehicleId: vehicle.id }))
      .expect(400);

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('regular-recurring'))
      .send(
        withSelectedRoute({
          rideType: RideType.REGULAR,
          vehicleId: vehicle.id,
          source: 'Noida',
          destination: 'Delhi',
          departureDate: START_DATE,
          departureTime: '09:00',
          totalSeats: 2,
          pricePerSeat: 200,
          recurring: true,
        }),
      )
      .expect(400);
  });

  it('creates same-day return occurrences with independent ids and reverse geometry', async () => {
    const { login, vehicle } = await publishableDriver();
    const response = await publishSeries(login.accessToken, vehicle.id, {
      returnEnabled: true,
      returnDepartureTime: '18:30',
      returnRouteSelectionToken: reverseRouteToken(),
    });

    const occurrences = response.body.series.occurrences as Array<{
      id: string;
      direction: RideDirection;
      departureDate: string;
      departureTime: string;
      source: string;
      destination: string;
      availableSeats: number;
    }>;
    const outbound = occurrences.filter(
      (item) => item.direction === RideDirection.OUTBOUND,
    );
    const inbound = occurrences.filter(
      (item) => item.direction === RideDirection.RETURN,
    );
    expect(outbound).toHaveLength(7);
    expect(inbound).toHaveLength(7);
    expect(new Set(occurrences.map((item) => item.id)).size).toBe(14);
    expect(inbound.every((item) => item.departureTime === '18:30:00')).toBe(true);
    expect(inbound[0].source).toBe('Noida Sector 62');
    expect(inbound[0].destination).toBe('Gurgaon Cyber City');
    expect(inbound[0].availableSeats).toBe(3);
    expect(inbound[0].id).not.toBe(outbound[0].id);
  });

  it('rejects reused outbound token, overnight return, and inverted times', async () => {
    const { login, vehicle } = await publishableDriver();
    const outbound = withSelectedRoute({
      vehicleId: vehicle.id,
      source: 'Gurgaon Cyber City',
      destination: 'Noida Sector 62',
    });

    await publishSeries(
      login.accessToken,
      vehicle.id,
      {
        returnEnabled: true,
        returnDepartureTime: '18:30',
        returnRouteSelectionToken: outbound.routeSelectionToken,
        routeSelectionToken: outbound.routeSelectionToken,
      },
      400,
    );

    await publishSeries(
      login.accessToken,
      vehicle.id,
      {
        returnEnabled: true,
        returnDepartureTime: '07:00',
        returnRouteSelectionToken: reverseRouteToken(),
      },
      400,
    );
  });

  it('is idempotent for the same key and payload, and conflicts on fingerprint mismatch', async () => {
    const { login, vehicle } = await publishableDriver();
    const key = uniqueIdempotencyKey('series-idem');
    const first = await publishSeries(
      login.accessToken,
      vehicle.id,
      {},
      201,
      key,
    );
    const second = await publishSeries(
      login.accessToken,
      vehicle.id,
      {},
      201,
      key,
    );
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.series.occurrences).toHaveLength(7);

    const count = await dataSource.getRepository(Ride).count({
      where: { seriesId: first.body.seriesId },
    });
    expect(count).toBe(7);

    await publishSeries(
      login.accessToken,
      vehicle.id,
      { pricePerSeat: 120 },
      409,
      key,
    );
  });

  it('serializes concurrent series publishes with the same key', async () => {
    const { login, vehicle } = await publishableDriver();
    const key = uniqueIdempotencyKey('series-concurrent');
    const body = seriesBody({ vehicleId: vehicle.id });
    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .set('Idempotency-Key', key)
        .send(body),
      request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .set('Idempotency-Key', key)
        .send(body),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).toBe(second.body.id);
    const count = await dataSource.getRepository(Ride).count({
      where: { seriesId: first.body.seriesId },
    });
    expect(count).toBe(7);
  });

  it('keeps seat inventory isolated across occurrence dates', async () => {
    const { login, vehicle } = await publishableDriver();
    const passenger = await fundedPassenger();
    const published = await publishSeries(login.accessToken, vehicle.id, {
      totalSeats: 2,
    });
    const monday = published.body.series.occurrences[0];
    const tuesday = published.body.series.occurrences[1];

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('series-book'))
      .send({
        rideId: monday.id,
        seats: 2,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/accept`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    const mondayRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: monday.id,
    });
    const tuesdayRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: tuesday.id,
    });
    expect(mondayRide.availableSeats).toBe(0);
    expect(tuesdayRide.availableSeats).toBe(2);

    const searchTuesday = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .query({
        source: 'Gurgaon',
        destination: 'Noida',
        date: tuesday.departureDate,
        rideType: RideType.COMMUTE,
      })
      .expect(200);
    const tuesdayMatch = searchTuesday.body.items.find(
      (item: { id: string }) => item.id === tuesday.id,
    );
    expect(tuesdayMatch).toBeDefined();
    expect(tuesdayMatch.availableSeats).toBe(2);
  });

  it('searches return rides on the reverse labels and not the outbound corridor labels', async () => {
    const { login, vehicle } = await publishableDriver();
    const passenger = await fundedPassenger();
    const published = await publishSeries(login.accessToken, vehicle.id, {
      returnEnabled: true,
      returnDepartureTime: '18:30',
      returnRouteSelectionToken: reverseRouteToken(),
    });
    const date = published.body.departureDate;
    const outboundSearch = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .query({
        source: 'Gurgaon Cyber City',
        destination: 'Noida Sector 62',
        date,
        rideType: RideType.COMMUTE,
      })
      .expect(200);
    expect(outboundSearch.body.items).toHaveLength(1);
    expect(outboundSearch.body.items[0].direction).toBe(RideDirection.OUTBOUND);

    const returnSearch = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .query({
        source: 'Noida Sector 62',
        destination: 'Gurgaon Cyber City',
        date,
        rideType: RideType.COMMUTE,
      })
      .expect(200);
    expect(returnSearch.body.items).toHaveLength(1);
    expect(returnSearch.body.items[0].direction).toBe(RideDirection.RETURN);
    expect(returnSearch.body.items[0].id).not.toBe(outboundSearch.body.items[0].id);
  });

  it('THIS_OCCURRENCE cancel leaves other dates; THIS_AND_FUTURE skips booked future rides', async () => {
    const { login, vehicle } = await publishableDriver();
    const passenger = await fundedPassenger();
    const published = await publishSeries(login.accessToken, vehicle.id, {
      totalSeats: 1,
    });
    const [first, second, third] = published.body.series.occurrences;

    await request(app.getHttpServer())
      .post(`/rides/${first.id}/cancel`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    const remainingFirst = await dataSource.getRepository(Ride).findOneByOrFail({
      id: first.id,
    });
    const remainingSecond = await dataSource.getRepository(Ride).findOneByOrFail({
      id: second.id,
    });
    expect(remainingFirst.status).toBe(RideStatus.CANCELLED);
    expect(remainingSecond.status).toBe(RideStatus.PUBLISHED);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('series-future-book'))
      .send({
        rideId: third.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/accept`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    const seriesCancel = await request(app.getHttpServer())
      .post(`/rides/${second.id}/cancel`)
      .query({ seriesScope: SeriesScope.THIS_AND_FUTURE })
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(seriesCancel.body.cancelledRideIds).toContain(second.id);
    expect(seriesCancel.body.skippedBookedRideIds).toContain(third.id);

    const secondAfter = await dataSource.getRepository(Ride).findOneByOrFail({
      id: second.id,
    });
    const thirdAfter = await dataSource.getRepository(Ride).findOneByOrFail({
      id: third.id,
    });
    expect(secondAfter.status).toBe(RideStatus.CANCELLED);
    expect(thirdAfter.status).toBe(RideStatus.PUBLISHED);
    expect(thirdAfter.availableSeats).toBe(0);
  });

  it('THIS_AND_FUTURE update is all-or-nothing when a future occurrence is booked', async () => {
    const { login, vehicle } = await publishableDriver();
    const passenger = await fundedPassenger();
    const published = await publishSeries(login.accessToken, vehicle.id);
    const [first, second] = published.body.series.occurrences;

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('series-update-book'))
      .send({
        rideId: second.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/accept`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/rides/${first.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        seriesScope: SeriesScope.THIS_AND_FUTURE,
        pricePerSeat: 150,
      })
      .expect(409);

    const firstAfter = await dataSource.getRepository(Ride).findOneByOrFail({
      id: first.id,
    });
    expect(firstAfter.pricePerSeat).toBe('100');
  });

  it('PostgreSQL DATE occurrence bounds exclude earlier THIS_AND_FUTURE dates', async () => {
    const { login, vehicle } = await publishableDriver();
    const published = await publishSeries(login.accessToken, vehicle.id, {
      notes: 'original',
    });
    const occurrences = published.body.series.occurrences as Array<{
      id: string;
      departureDate: string;
    }>;
    const earlier = occurrences[0];
    const selected = occurrences[1];

    const raw = await dataSource.query(
      `SELECT occurrence_date::text AS txt FROM rides WHERE id = $1`,
      [selected.id],
    );
    expect(raw[0].txt).toBe(selected.departureDate);

    const stored = await dataSource.getRepository(Ride).findOneByOrFail({
      id: selected.id,
    });
    expect(toCivilDateString(stored.occurrenceDate as string | Date)).toBe(
      raw[0].txt,
    );
    if (stored.occurrenceDate instanceof Date) {
      const isoDay = stored.occurrenceDate.toISOString().slice(0, 10);
      const civil = toCivilDateString(stored.occurrenceDate);
      expect(civil).toBe(raw[0].txt);
      if (isoDay !== civil) {
        expect(isoDay < civil).toBe(true);
      }
    }

    await request(app.getHttpServer())
      .patch(`/rides/${selected.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        seriesScope: SeriesScope.THIS_AND_FUTURE,
        notes: 'from-second-occurrence',
      })
      .expect(200);

    const earlierAfter = await dataSource.getRepository(Ride).findOneByOrFail({
      id: earlier.id,
    });
    const selectedAfter = await dataSource.getRepository(Ride).findOneByOrFail({
      id: selected.id,
    });
    const laterAfter = await dataSource.getRepository(Ride).findOneByOrFail({
      id: occurrences[2].id,
    });
    expect(earlierAfter.notes).toBe('original');
    expect(selectedAfter.notes).toBe('from-second-occurrence');
    expect(laterAfter.notes).toBe('from-second-occurrence');
  });

  it('THIS_AND_FUTURE cancel refunds the selected booked ride once and skips later booked dates', async () => {
    const { login, vehicle } = await publishableDriver();
    const confirmedPassenger = await fundedPassenger();
    const pendingPassenger = await fundedPassenger();
    const laterConfirmedPassenger = await fundedPassenger();
    const published = await publishSeries(login.accessToken, vehicle.id, {
      totalSeats: 2,
      returnEnabled: true,
      returnDepartureTime: '18:30',
      returnRouteSelectionToken: reverseRouteToken(),
    });
    const outbound = (
      published.body.series.occurrences as Array<{
        id: string;
        direction: RideDirection;
        availableSeats: number;
      }>
    ).filter((item) => item.direction === RideDirection.OUTBOUND);
    const inbound = (
      published.body.series.occurrences as Array<{
        id: string;
        direction: RideDirection;
        availableSeats: number;
      }>
    ).filter((item) => item.direction === RideDirection.RETURN);
    const [selected, pendingLater, confirmedLater, unbookedLater] = outbound;

    const selectedBooking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${confirmedPassenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('series-selected-book'))
      .send({
        rideId: selected.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/bookings/${selectedBooking.body.id}/accept`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${pendingPassenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('series-pending-book'))
      .send({
        rideId: pendingLater.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    const laterBooking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${laterConfirmedPassenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('series-later-book'))
      .send({
        rideId: confirmedLater.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/bookings/${laterBooking.body.id}/accept`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    const pendingBefore = await dataSource.getRepository(Ride).findOneByOrFail({
      id: pendingLater.id,
    });
    const confirmedBefore = await dataSource.getRepository(Ride).findOneByOrFail({
      id: confirmedLater.id,
    });
    const returnBefore = await dataSource.getRepository(Ride).findOneByOrFail({
      id: inbound[0].id,
    });

    const cancelled = await request(app.getHttpServer())
      .post(`/rides/${selected.id}/cancel`)
      .query({ seriesScope: SeriesScope.THIS_AND_FUTURE })
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(cancelled.body.cancelledRideIds).toEqual(
      expect.arrayContaining([selected.id, unbookedLater.id]),
    );
    expect(cancelled.body.cancelledRideIds).not.toContain(pendingLater.id);
    expect(cancelled.body.cancelledRideIds).not.toContain(confirmedLater.id);
    expect(cancelled.body.skippedBookedRideIds).toEqual(
      expect.arrayContaining([pendingLater.id, confirmedLater.id]),
    );
    expect(cancelled.body.cancelledBookingCount).toBe(1);

    const refunds = await dataSource.getRepository(WalletTransaction).find({
      where: {
        referenceId: selectedBooking.body.id,
        transactionType: WalletTransactionType.REFUND,
      },
    });
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount).toBe(String(selectedBooking.body.totalAmount));

    const cancelNotices = await dataSource.getRepository(Notification).find({
      where: {
        recipientUserId: confirmedPassenger.login.user.id,
        type: NotificationType.COMMUTE_BOOKING_CANCELLED,
      },
    });
    expect(cancelNotices).toHaveLength(1);

    const pendingAfter = await dataSource.getRepository(Ride).findOneByOrFail({
      id: pendingLater.id,
    });
    const confirmedAfter = await dataSource.getRepository(Ride).findOneByOrFail({
      id: confirmedLater.id,
    });
    const returnAfter = await dataSource.getRepository(Ride).findOneByOrFail({
      id: inbound[0].id,
    });
    const unbookedAfter = await dataSource.getRepository(Ride).findOneByOrFail({
      id: unbookedLater.id,
    });
    expect(pendingAfter.status).toBe(RideStatus.PUBLISHED);
    expect(pendingAfter.availableSeats).toBe(pendingBefore.availableSeats);
    expect(confirmedAfter.status).toBe(RideStatus.PUBLISHED);
    expect(confirmedAfter.availableSeats).toBe(confirmedBefore.availableSeats);
    expect(returnAfter.status).toBe(RideStatus.PUBLISHED);
    expect(returnAfter.availableSeats).toBe(returnBefore.availableSeats);
    expect(unbookedAfter.status).toBe(RideStatus.CANCELLED);

    const series = await dataSource.getRepository(RideSeries).findOneByOrFail({
      id: published.body.seriesId,
    });
    expect(series.status).toBe(RideSeriesStatus.ACTIVE);
  });

  it('THIS_AND_FUTURE cancel of IN_PROGRESS selected occurrence is a 409 with no sibling changes', async () => {
    const { login, vehicle } = await publishableDriver();
    const published = await publishSeries(login.accessToken, vehicle.id);
    const [selected, sibling] = published.body.series.occurrences as Array<{
      id: string;
    }>;

    await dataSource.getRepository(Ride).update(
      { id: selected.id },
      { status: RideStatus.IN_PROGRESS },
    );

    const conflict = await request(app.getHttpServer())
      .post(`/rides/${selected.id}/cancel`)
      .query({ seriesScope: SeriesScope.THIS_AND_FUTURE })
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(409);
    expect(conflict.body.code).toBe('COMMUTE_SERIES_OCCURRENCE_IN_PROGRESS');

    const selectedAfter = await dataSource.getRepository(Ride).findOneByOrFail({
      id: selected.id,
    });
    const siblingAfter = await dataSource.getRepository(Ride).findOneByOrFail({
      id: sibling.id,
    });
    expect(selectedAfter.status).toBe(RideStatus.IN_PROGRESS);
    expect(siblingAfter.status).toBe(RideStatus.PUBLISHED);
  });

  it('series becomes CANCELLED only after the last remaining occurrence is cancelled', async () => {
    const { login, vehicle } = await publishableDriver();
    const published = await publishSeries(login.accessToken, vehicle.id, {
      returnEnabled: true,
      returnDepartureTime: '18:30',
      returnRouteSelectionToken: reverseRouteToken(),
    });
    const outbound = (
      published.body.series.occurrences as Array<{
        id: string;
        direction: RideDirection;
      }>
    ).filter((item) => item.direction === RideDirection.OUTBOUND);
    const inbound = (
      published.body.series.occurrences as Array<{
        id: string;
        direction: RideDirection;
      }>
    ).filter((item) => item.direction === RideDirection.RETURN);

    await request(app.getHttpServer())
      .post(`/rides/${outbound[0].id}/cancel`)
      .query({ seriesScope: SeriesScope.THIS_AND_FUTURE })
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    const afterOutbound = await dataSource
      .getRepository(RideSeries)
      .findOneByOrFail({ id: published.body.seriesId });
    expect(afterOutbound.status).toBe(RideSeriesStatus.ACTIVE);
    const stillReturn = await dataSource.getRepository(Ride).findOneByOrFail({
      id: inbound[0].id,
    });
    expect(stillReturn.status).toBe(RideStatus.PUBLISHED);

    await request(app.getHttpServer())
      .post(`/rides/${inbound[0].id}/cancel`)
      .query({ seriesScope: SeriesScope.THIS_AND_FUTURE })
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    const afterReturn = await dataSource
      .getRepository(RideSeries)
      .findOneByOrFail({ id: published.body.seriesId });
    expect(afterReturn.status).toBe(RideSeriesStatus.CANCELLED);
  });

  it('rolls back the series when an occurrence insert fails mid-generation', async () => {
    const { login, vehicle } = await publishableDriver();
    const originalSave = Repository.prototype.save;
    let rideSaves = 0;
    const spy = jest
      .spyOn(Repository.prototype, 'save')
      .mockImplementation(async function (
        this: Repository<unknown>,
        entity: unknown,
        options?: unknown,
      ) {
        const table = this.metadata?.tableName;
        const target = this.metadata?.target;
        const isRide =
          table === 'rides' ||
          target === Ride ||
          (typeof target === 'function' && target.name === 'Ride');
        if (isRide) {
          rideSaves += 1;
          if (rideSaves >= 3) {
            throw new Error('forced occurrence insert failure');
          }
        }
        return originalSave.apply(this, [entity, options] as never);
      });

    try {
      await publishSeries(login.accessToken, vehicle.id, {}, 500);
      const leftoverRides = await dataSource.getRepository(Ride).count({
        where: { driverId: login.user.id },
      });
      const leftoverSeries = await dataSource.getRepository(RideSeries).count({
        where: { driverId: login.user.id },
      });
      expect(leftoverRides).toBe(0);
      expect(leftoverSeries).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('concurrent same-key different payloads let exactly one payload win', async () => {
    const { login, vehicle } = await publishableDriver();
    const key = uniqueIdempotencyKey('series-conflict-payload');
    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .set('Idempotency-Key', key)
        .send(seriesBody({ vehicleId: vehicle.id, pricePerSeat: 100 })),
      request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .set('Idempotency-Key', key)
        .send(seriesBody({ vehicleId: vehicle.id, pricePerSeat: 120 })),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    const winner = first.status === 201 ? first : second;
    const winnerPrice = winner.body.pricePerSeat;
    expect(['100', '120']).toContain(winnerPrice);
    const stored = await dataSource.getRepository(Ride).find({
      where: { seriesId: winner.body.seriesId },
    });
    expect(stored).toHaveLength(7);
    expect(stored.every((ride) => ride.pricePerSeat === winnerPrice)).toBe(true);
    const seriesCount = await dataSource.getRepository(RideSeries).count({
      where: { driverId: login.user.id },
    });
    expect(seriesCount).toBe(1);
  });

  it('different idempotency keys competing for the same driver slot leave no orphan series', async () => {
    const { login, vehicle } = await publishableDriver();
    const first = await publishSeries(
      login.accessToken,
      vehicle.id,
      {},
      201,
      uniqueIdempotencyKey('series-slot-a'),
    );
    const second = await publishSeries(
      login.accessToken,
      vehicle.id,
      {},
      409,
      uniqueIdempotencyKey('series-slot-b'),
    );
    expect(second.body.code).toBe('COMMUTE_SCHEDULE_CONFLICT');
    const seriesCount = await dataSource.getRepository(RideSeries).count({
      where: { driverId: login.user.id },
    });
    const rideCount = await dataSource.getRepository(Ride).count({
      where: { driverId: login.user.id },
    });
    expect(seriesCount).toBe(1);
    expect(rideCount).toBe(7);
    expect(first.body.seriesId).toBeTruthy();
  });

  it('matches return geometry by reversed coordinates and rejects a mismatched return token', async () => {
    const { login, vehicle } = await publishableDriver();
    const passenger = await fundedPassenger();
    await publishSeries(
      login.accessToken,
      vehicle.id,
      {
        returnEnabled: true,
        returnDepartureTime: '18:30',
        returnRouteSelectionToken: mintSelectedRouteToken({
          sourceLatitude: 30.3165,
          sourceLongitude: 78.0322,
          destinationLatitude: 29.9457,
          destinationLongitude: 78.1642,
        }),
      },
      400,
    );

    const published = await publishSeries(login.accessToken, vehicle.id, {
      returnEnabled: true,
      returnDepartureTime: '18:30',
      returnRouteSelectionToken: reverseRouteToken(),
    });
    const date = published.body.departureDate;
    const {
      sourceLatitude,
      sourceLongitude,
      destinationLatitude,
      destinationLongitude,
    } = SELECTED_ROUTE_TEST_ENDPOINTS;

    const outboundSearch = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .query({
        source: 'Gurgaon Cyber City',
        destination: 'Noida Sector 62',
        date,
        rideType: RideType.COMMUTE,
        pickupLatitude: sourceLatitude,
        pickupLongitude: sourceLongitude,
        dropoffLatitude: destinationLatitude,
        dropoffLongitude: destinationLongitude,
      })
      .expect(200);
    expect(outboundSearch.body.items).toHaveLength(1);
    expect(outboundSearch.body.items[0].direction).toBe(RideDirection.OUTBOUND);
    expect(outboundSearch.body.items[0].id).toBe(published.body.id);

    const returnSearch = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .query({
        source: 'Noida Sector 62',
        destination: 'Gurgaon Cyber City',
        date,
        rideType: RideType.COMMUTE,
        pickupLatitude: destinationLatitude,
        pickupLongitude: destinationLongitude,
        dropoffLatitude: sourceLatitude,
        dropoffLongitude: sourceLongitude,
      })
      .expect(200);
    expect(returnSearch.body.items).toHaveLength(1);
    expect(returnSearch.body.items[0].direction).toBe(RideDirection.RETURN);
    expect(returnSearch.body.items[0].id).not.toBe(published.body.id);

    const stored = await dataSource.getRepository(RideSeries).findOneByOrFail({
      id: published.body.seriesId,
    });
    expect(stored.outboundRoute).toBeTruthy();
    expect(stored.returnRoute).toBeTruthy();
    expect(stored.outboundRoute).not.toEqual(stored.returnRoute);
  });

  it('THIS_AND_FUTURE updates only later unbooked same-direction occurrences', async () => {
    const { login, vehicle } = await publishableDriver();
    const published = await publishSeries(login.accessToken, vehicle.id, {
      notes: 'before',
      returnEnabled: true,
      returnDepartureTime: '18:30',
      returnRouteSelectionToken: reverseRouteToken(),
    });
    const outbound = (
      published.body.series.occurrences as Array<{
        id: string;
        direction: RideDirection;
      }>
    ).filter((item) => item.direction === RideDirection.OUTBOUND);
    const inbound = (
      published.body.series.occurrences as Array<{
        id: string;
        direction: RideDirection;
      }>
    ).filter((item) => item.direction === RideDirection.RETURN);

    await dataSource.getRepository(Ride).update(
      { id: outbound[outbound.length - 1].id },
      { status: RideStatus.COMPLETED },
    );

    await request(app.getHttpServer())
      .patch(`/rides/${outbound[1].id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        seriesScope: SeriesScope.THIS_AND_FUTURE,
        pricePerSeat: 150,
        notes: 'updated-window',
      })
      .expect(200);

    const earlier = await dataSource.getRepository(Ride).findOneByOrFail({
      id: outbound[0].id,
    });
    const selected = await dataSource.getRepository(Ride).findOneByOrFail({
      id: outbound[1].id,
    });
    const middle = await dataSource.getRepository(Ride).findOneByOrFail({
      id: outbound[2].id,
    });
    const completed = await dataSource.getRepository(Ride).findOneByOrFail({
      id: outbound[outbound.length - 1].id,
    });
    const returnRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: inbound[1].id,
    });
    expect(earlier.pricePerSeat).toBe('100');
    expect(earlier.notes).toBe('before');
    expect(selected.pricePerSeat).toBe('150');
    expect(selected.notes).toBe('updated-window');
    expect(middle.pricePerSeat).toBe('150');
    expect(completed.status).toBe(RideStatus.COMPLETED);
    expect(completed.pricePerSeat).toBe('100');
    expect(returnRide.pricePerSeat).toBe('100');
    expect(returnRide.notes).toBe('before');
  });

  it('completing one generated occurrence settles, invoices, and records rewards once', async () => {
    const { login, vehicle } = await publishableDriver();
    const passengerA = await fundedPassenger();
    const passengerB = await fundedPassenger();
    const campaign = await dataSource.getRepository(CommuteRewardCampaign).save(
      dataSource.getRepository(CommuteRewardCampaign).create({
        title: 'Series lifecycle campaign',
        status: CommuteRewardCampaignStatus.ACTIVE,
        timezone: 'Asia/Kolkata',
        startsAt: new Date(Date.now() - 24 * 3600_000),
        endsAt: new Date(Date.now() + 365 * 24 * 3600_000),
        configVersion: 1,
      }),
    );
    campaignIds.push(campaign.id);

    const published = await publishSeries(login.accessToken, vehicle.id, {
      totalSeats: 3,
    });
    const [selected, sibling] = published.body.series.occurrences as Array<{
      id: string;
    }>;

    for (const passenger of [passengerA, passengerB]) {
      const booking = await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('series-life-book'))
        .send({
          rideId: selected.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_NOW,
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/bookings/${booking.body.id}/accept`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);
    }

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      login.accessToken,
      selected.id,
      pickupOtpPepper(),
    );

    const complete = await request(app.getHttpServer())
      .post(`/rides/${selected.id}/complete`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);
    expect(complete.body.commuteSettlement).toMatchObject({
      settledBookingCount: 2,
    });

    const selectedJobs = await dataSource.getRepository(GstInvoiceJob).find({
      where: { rideId: selected.id },
    });
    const siblingJobs = await dataSource.getRepository(GstInvoiceJob).find({
      where: { rideId: sibling.id },
    });
    expect(selectedJobs).toHaveLength(2);
    expect(siblingJobs).toHaveLength(0);

    const selectedTrips = await dataSource
      .getRepository(CommuteRewardQualifyingTrip)
      .find({ where: { rideId: selected.id, campaignId: campaign.id } });
    const siblingTrips = await dataSource
      .getRepository(CommuteRewardQualifyingTrip)
      .find({ where: { rideId: sibling.id, campaignId: campaign.id } });
    expect(selectedTrips).toHaveLength(1);
    expect(siblingTrips).toHaveLength(0);

    const siblingRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: sibling.id,
    });
    expect(siblingRide.status).toBe(RideStatus.PUBLISHED);

    const retry = await request(app.getHttpServer())
      .post(`/rides/${selected.id}/complete`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);
    expect(retry.body.alreadyCompleted).toBe(true);
    const jobsAfterRetry = await dataSource.getRepository(GstInvoiceJob).find({
      where: { rideId: selected.id },
    });
    const tripsAfterRetry = await dataSource
      .getRepository(CommuteRewardQualifyingTrip)
      .find({ where: { rideId: selected.id, campaignId: campaign.id } });
    expect(jobsAfterRetry).toHaveLength(2);
    expect(tripsAfterRetry).toHaveLength(1);
  });
});
