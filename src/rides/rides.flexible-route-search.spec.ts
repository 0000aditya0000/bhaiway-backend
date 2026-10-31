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
import { RideType } from './enums/ride.enums';
import { RidesModule } from './rides.module';
import { RideMatchCategory } from './route/route-geometry';
import { withSelectedRoute } from './test/selected-route-test.helpers';

const NOIDA = { latitude: 28.5355, longitude: 77.391 };
const DEHRADUN = { latitude: 30.3165, longitude: 78.0322 };

// Points along the Noida -> Dehradun vector:
const PICKUP_15KM_BEHIND = { latitude: 28.4087, longitude: 77.3391 };
const PICKUP_35KM_BEHIND = { latitude: 28.2397, longitude: 77.2699 };
const DEST_25KM_BEYOND = { latitude: 30.5278, longitude: 78.1202 };
const DEST_55KM_BEYOND = { latitude: 30.7813, longitude: 78.2258 };

interface SearchItemResponse {
  id: string;
  matchType?: RideMatchCategory | null;
  isFlexibleMatch?: boolean;
  requiresIndependentPickupTravel?: boolean;
  requiresIndependentDestinationTravel?: boolean;
  pickupFlexibilityDistanceKm?: number | null;
  destinationExtensionDistanceKm?: number | null;
  actualDriverPickupLocation?: {
    latitude: number;
    longitude: number;
    name?: string;
  } | null;
  actualDriverDropLocation?: {
    latitude: number;
    longitude: number;
    name?: string;
  } | null;
}

interface SearchResponsePayload {
  items: SearchItemResponse[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

describe('Flexible Route Search (GET /rides/search integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  const tracked: TestWalletContext[] = [];
  const departureDate = '2027-10-10';
  let passengerAccessToken: string;

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

  beforeEach(async () => {
    passengerAccessToken = (await createAuthenticatedUser()).accessToken;
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

  async function publishRide(params?: {
    source?: string;
    destination?: string;
    sourceLatitude?: number;
    sourceLongitude?: number;
    destinationLatitude?: number;
    destinationLongitude?: number;
    departureTime?: string;
    departureDate?: string;
  }) {
    const login = await createAuthenticatedUser();
    await dataSource.getRepository(UserProfile).save(
      dataSource.getRepository(UserProfile).create({
        userId: login.user.id,
        firstName: 'Driver',
        lastName: 'Route',
        displayName: 'Driver Route',
      }),
    );

    const vehicle = await vehiclesService.create(login.user.id, {
      vehicleType: VehicleType.CAR,
      make: 'Maruti',
      model: 'Swift',
      registrationNumber: `DL01${Date.now().toString().slice(-6)}${Math.floor(
        Math.random() * 10,
      )}`,
      registrationYear: 2023,
      color: 'Silver',
      seatingCapacity: 4,
    });
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
    await markVerified(login.user.id, VerificationType.VEHICLE);

    const server = app.getHttpServer() as unknown as Parameters<
      typeof request
    >[0];
    const rideRes = await request(server)
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(
        withSelectedRoute({
          rideType: RideType.REGULAR,
          vehicleId: vehicle.id,
          source: params?.source ?? 'Noida',
          destination: params?.destination ?? 'Dehradun',
          sourceLatitude: params?.sourceLatitude ?? NOIDA.latitude,
          sourceLongitude: params?.sourceLongitude ?? NOIDA.longitude,
          destinationLatitude: params?.destinationLatitude ?? DEHRADUN.latitude,
          destinationLongitude:
            params?.destinationLongitude ?? DEHRADUN.longitude,
          departureDate: params?.departureDate ?? departureDate,
          departureTime: params?.departureTime ?? '08:00',
          totalSeats: 4,
          pricePerSeat: 300,
        }),
      )
      .expect(201);

    return { login, ride: rideRes.body as { id: string } };
  }

  async function searchRides(
    token: string,
    params: Record<string, string | number>,
  ): Promise<SearchResponsePayload> {
    const server = app.getHttpServer() as unknown as Parameters<
      typeof request
    >[0];
    const res = await request(server)
      .get('/rides/search')
      .set('Authorization', `Bearer ${token}`)
      .query(params)
      .expect(200);
    return res.body as SearchResponsePayload;
  }

  it('Backward pickup (15 km behind source): discovers ride with BACKWARD_PICKUP_MATCH metadata', async () => {
    const { ride } = await publishRide();

    const body = await searchRides(passengerAccessToken, {
      source: 'Greater Noida',
      destination: 'Dehradun',
      date: departureDate,
      pickupLatitude: PICKUP_15KM_BEHIND.latitude,
      pickupLongitude: PICKUP_15KM_BEHIND.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    });

    const hit = body.items.find((item) => item.id === ride.id);
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe(RideMatchCategory.BACKWARD_PICKUP_MATCH);
    expect(hit?.isFlexibleMatch).toBe(true);
    expect(hit?.requiresIndependentPickupTravel).toBe(true);
    expect(hit?.requiresIndependentDestinationTravel).toBe(false);
    expect(hit?.pickupFlexibilityDistanceKm).toBeCloseTo(15.0, 0);
    expect(hit?.destinationExtensionDistanceKm).toBeNull();
    expect(hit?.actualDriverPickupLocation).toEqual({
      latitude: NOIDA.latitude,
      longitude: NOIDA.longitude,
      name: 'Noida',
    });
    expect(hit?.actualDriverDropLocation).toEqual({
      latitude: DEHRADUN.latitude,
      longitude: DEHRADUN.longitude,
      name: 'Dehradun',
    });
  });

  it('Backward pickup (> 30 km behind source): rejects and does not discover ride', async () => {
    const { ride } = await publishRide();

    const body = await searchRides(passengerAccessToken, {
      source: 'Far South',
      destination: 'Dehradun',
      date: departureDate,
      pickupLatitude: PICKUP_35KM_BEHIND.latitude,
      pickupLongitude: PICKUP_35KM_BEHIND.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    });

    const hit = body.items.find((item) => item.id === ride.id);
    expect(hit).toBeUndefined();
  });

  it('Destination extension (25 km beyond destination): discovers ride with EXTENDED_DESTINATION_MATCH metadata', async () => {
    const { ride } = await publishRide();

    const body = await searchRides(passengerAccessToken, {
      source: 'Noida',
      destination: 'Mussoorie',
      date: departureDate,
      pickupLatitude: NOIDA.latitude,
      pickupLongitude: NOIDA.longitude,
      dropoffLatitude: DEST_25KM_BEYOND.latitude,
      dropoffLongitude: DEST_25KM_BEYOND.longitude,
    });

    const hit = body.items.find((item) => item.id === ride.id);
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe(RideMatchCategory.EXTENDED_DESTINATION_MATCH);
    expect(hit?.isFlexibleMatch).toBe(true);
    expect(hit?.requiresIndependentPickupTravel).toBe(false);
    expect(hit?.requiresIndependentDestinationTravel).toBe(true);
    expect(hit?.pickupFlexibilityDistanceKm).toBeNull();
    expect(hit?.destinationExtensionDistanceKm).toBeCloseTo(25.0, 0);
  });

  it('Destination extension (> 50 km beyond destination): rejects and does not discover ride', async () => {
    const { ride } = await publishRide();

    const body = await searchRides(passengerAccessToken, {
      source: 'Noida',
      destination: 'Far North',
      date: departureDate,
      pickupLatitude: NOIDA.latitude,
      pickupLongitude: NOIDA.longitude,
      dropoffLatitude: DEST_55KM_BEYOND.latitude,
      dropoffLongitude: DEST_55KM_BEYOND.longitude,
    });

    const hit = body.items.find((item) => item.id === ride.id);
    expect(hit).toBeUndefined();
  });

  it('Combined flexible match (15 km behind pickup AND 25 km beyond destination): discovers ride with FLEXIBLE_PICKUP_AND_DESTINATION_MATCH', async () => {
    const { ride } = await publishRide();

    const body = await searchRides(passengerAccessToken, {
      source: 'Greater Noida',
      destination: 'Mussoorie',
      date: departureDate,
      pickupLatitude: PICKUP_15KM_BEHIND.latitude,
      pickupLongitude: PICKUP_15KM_BEHIND.longitude,
      dropoffLatitude: DEST_25KM_BEYOND.latitude,
      dropoffLongitude: DEST_25KM_BEYOND.longitude,
    });

    const hit = body.items.find((item) => item.id === ride.id);
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe(
      RideMatchCategory.FLEXIBLE_PICKUP_AND_DESTINATION_MATCH,
    );
    expect(hit?.isFlexibleMatch).toBe(true);
    expect(hit?.requiresIndependentPickupTravel).toBe(true);
    expect(hit?.requiresIndependentDestinationTravel).toBe(true);
    expect(hit?.pickupFlexibilityDistanceKm).toBeCloseTo(15.0, 0);
    expect(hit?.destinationExtensionDistanceKm).toBeCloseTo(25.0, 0);
  });

  it('Ranking priority: Normal forward match strictly outranks backward pickup match', async () => {
    const rideA = await publishRide({
      source: 'Start Behind',
      sourceLatitude: PICKUP_15KM_BEHIND.latitude,
      sourceLongitude: PICKUP_15KM_BEHIND.longitude,
      destinationLatitude: DEHRADUN.latitude,
      destinationLongitude: DEHRADUN.longitude,
      departureTime: '10:00',
    });

    const rideB = await publishRide({
      source: 'Noida',
      sourceLatitude: NOIDA.latitude,
      sourceLongitude: NOIDA.longitude,
      destinationLatitude: DEHRADUN.latitude,
      destinationLongitude: DEHRADUN.longitude,
      departureTime: '09:00',
    });

    const body = await searchRides(passengerAccessToken, {
      source: 'Search',
      destination: 'Dehradun',
      date: departureDate,
      pickupLatitude: PICKUP_15KM_BEHIND.latitude,
      pickupLongitude: PICKUP_15KM_BEHIND.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    });

    const indexA = body.items.findIndex((item) => item.id === rideA.ride.id);
    const indexB = body.items.findIndex((item) => item.id === rideB.ride.id);

    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexB).toBeGreaterThanOrEqual(0);
    expect(indexA).toBeLessThan(indexB);
    expect(body.items[indexA].matchType).toBe(
      RideMatchCategory.FORWARD_ROUTE_MATCH,
    );
    expect(body.items[indexB].matchType).toBe(
      RideMatchCategory.BACKWARD_PICKUP_MATCH,
    );
  });

  it('Preserves exact place-name text search with backward compatibility (no coordinates)', async () => {
    const { ride } = await publishRide({
      source: 'Alpha',
      destination: 'Omega',
    });

    const body = await searchRides(passengerAccessToken, {
      source: 'Alpha',
      destination: 'Omega',
      date: departureDate,
    });

    const hit = body.items.find((item) => item.id === ride.id);
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBeNull();
    expect(hit?.isFlexibleMatch).toBe(false);
    expect(hit?.pickupFlexibilityDistanceKm).toBeNull();
    expect(hit?.destinationExtensionDistanceKm).toBeNull();
  });
});
