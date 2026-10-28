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
import { RideDirectionsService } from './route/ride-directions.service';
import { buildStraightRouteGeometry } from './route/route-geometry';
import { RidesModule } from './rides.module';
import {
  mintSelectedRouteToken,
  withSelectedRoute,
} from './test/selected-route-test.helpers';

const NOIDA = { latitude: 28.5355, longitude: 77.391 };
const DELHI = { latitude: 28.6139, longitude: 77.209 };
const MUMBAI = { latitude: 19.076, longitude: 72.8777 };

describe('Driver-selected route options (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  const tracked: TestWalletContext[] = [];

  const primary = buildStraightRouteGeometry(NOIDA, DELHI);
  const alternate = buildStraightRouteGeometry(
    { latitude: NOIDA.latitude + 0.02, longitude: NOIDA.longitude },
    DELHI,
  );

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
      ],
    })
      .overrideProvider(OTP_PROVIDER)
      .useValue({
        verifyAccessToken: jest
          .fn()
          .mockRejectedValue(new Msg91ResponseFormatError('disabled in tests')),
      })
      .overrideProvider(RideDirectionsService)
      .useValue({
        listDrivingRouteOptions: jest.fn(async () => [
          {
            ...primary,
            source: NOIDA,
            destination: DELHI,
            durationSeconds: 5400,
          },
          {
            ...alternate,
            source: NOIDA,
            destination: DELHI,
            durationSeconds: 6100,
          },
        ]),
        buildDrivingRouteGeometry: jest.fn(),
        buildRouteGeometry: jest.fn(),
        buildRouteGeometryFromPlaceNames: jest.fn(),
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
      if (!ctx) {
        continue;
      }
      await dataSource.getRepository(Ride).delete({ driverId: ctx.userId });
      await dataSource.getRepository(Vehicle).delete({ userId: ctx.userId });
      await dataSource.getRepository(UserProfile).delete({ userId: ctx.userId });
      await dataSource.getRepository(UserVerification).delete({
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

  async function eligibleDriver() {
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
        firstName: 'Route',
        lastName: 'Driver',
        displayName: 'Route Driver',
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example.com/user.jpg',
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
    return { login, vehicle };
  }

  it('returns multiple provider alternatives with selection tokens', async () => {
    const { login } = await eligibleDriver();
    const res = await request(app.getHttpServer())
      .post('/rides/route-options')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        sourceLatitude: NOIDA.latitude,
        sourceLongitude: NOIDA.longitude,
        destinationLatitude: DELHI.latitude,
        destinationLongitude: DELHI.longitude,
      })
      .expect(200);

    expect(res.body.options).toHaveLength(2);
    expect(res.body.options[0].selectionToken).toBeTruthy();
    expect(res.body.options[0].polyline).toBe(primary.polylineEncoded);
    expect(res.body.options[1].distanceMeters).toBe(alternate.lengthMeters);
  });

  it('allows publishing the only selected option and persists geometry', async () => {
    const { login, vehicle } = await eligibleDriver();
    const options = await request(app.getHttpServer())
      .post('/rides/route-options')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        sourceLatitude: NOIDA.latitude,
        sourceLongitude: NOIDA.longitude,
        destinationLatitude: DELHI.latitude,
        destinationLongitude: DELHI.longitude,
      })
      .expect(200);

    const created = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        rideType: RideType.REGULAR,
        vehicleId: vehicle.id,
        source: 'Noida',
        destination: 'Delhi',
        sourceLatitude: NOIDA.latitude,
        sourceLongitude: NOIDA.longitude,
        destinationLatitude: DELHI.latitude,
        destinationLongitude: DELHI.longitude,
        departureDate: '2028-05-01',
        departureTime: '09:00',
        totalSeats: 3,
        pricePerSeat: 200,
        routeSelectionToken: options.body.options[0].selectionToken,
      })
      .expect(201);

    expect(created.body.routeSelected).toBe(true);
    expect(created.body.routeLengthMeters).toBe(primary.lengthMeters);
    const stored = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: created.body.id });
    expect(stored.routePolyline).toBe(primary.polylineEncoded);
    expect(stored.routeSelectedAt).toBeTruthy();
    expect(stored.routeSelectionId).toBeTruthy();
  });

  it('rejects missing, expired, tampered, and endpoint-mismatched tokens', async () => {
    const { login, vehicle } = await eligibleDriver();
    const base = {
      rideType: RideType.REGULAR,
      vehicleId: vehicle.id,
      source: 'Noida',
      destination: 'Delhi',
      sourceLatitude: NOIDA.latitude,
      sourceLongitude: NOIDA.longitude,
      destinationLatitude: DELHI.latitude,
      destinationLongitude: DELHI.longitude,
      departureDate: '2028-05-01',
      departureTime: '09:00',
      totalSeats: 3,
      pricePerSeat: 200,
    };

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(base)
      .expect(400);

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        ...base,
        routeSelectionToken: mintSelectedRouteToken({
          ...NOIDA,
          sourceLatitude: NOIDA.latitude,
          sourceLongitude: NOIDA.longitude,
          destinationLatitude: DELHI.latitude,
          destinationLongitude: DELHI.longitude,
          expired: true,
        }),
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        ...base,
        routeSelectionToken: `${mintSelectedRouteToken({
          sourceLatitude: NOIDA.latitude,
          sourceLongitude: NOIDA.longitude,
          destinationLatitude: DELHI.latitude,
          destinationLongitude: DELHI.longitude,
        })}tampered`,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        ...base,
        sourceLatitude: MUMBAI.latitude,
        sourceLongitude: MUMBAI.longitude,
        routeSelectionToken: mintSelectedRouteToken({
          sourceLatitude: NOIDA.latitude,
          sourceLongitude: NOIDA.longitude,
          destinationLatitude: DELHI.latitude,
          destinationLongitude: DELHI.longitude,
        }),
      })
      .expect(400);
  });

  it('does not require a new selection for unrelated updates', async () => {
    const { login, vehicle } = await eligibleDriver();
    const created = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send(
        withSelectedRoute({
          rideType: RideType.REGULAR,
          vehicleId: vehicle.id,
          source: 'Noida',
          destination: 'Delhi',
          sourceLatitude: NOIDA.latitude,
          sourceLongitude: NOIDA.longitude,
          destinationLatitude: DELHI.latitude,
          destinationLongitude: DELHI.longitude,
          departureDate: '2028-05-01',
          departureTime: '09:00',
          totalSeats: 3,
          pricePerSeat: 200,
        }),
      )
      .expect(201);

    const updated = await request(app.getHttpServer())
      .patch(`/rides/${created.body.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ notes: 'No smoking please', totalSeats: 2 })
      .expect(200);

    expect(updated.body.notes).toBe('No smoking please');
    expect(updated.body.totalSeats).toBe(2);
    const stored = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: created.body.id });
    expect(stored.routePolyline).toBeTruthy();
    expect(stored.routeSelectedAt).toBeTruthy();
  });
});
