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
import { Ride } from './entities/ride.entity';
import { RideType } from './enums/ride.enums';
import { RidesModule } from './rides.module';

const NOIDA = { latitude: 28.5355, longitude: 77.391 };
const INDIRAPURAM = { latitude: 28.6415, longitude: 77.372 };
const MEERUT = { latitude: 28.9845, longitude: 77.7064 };
const DEHRADUN = { latitude: 30.3165, longitude: 78.0322 };

describe('Commute route match percentage (GET /rides/search)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  const tracked: TestWalletContext[] = [];
  const departureDate = '2026-09-20';

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

  async function createDriver() {
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

    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: 10000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('commute-route-match-driver'),
    });

    return { login, vehicle };
  }

  async function publishCommuteNoidaDehradun() {
    const { login, vehicle } = await createDriver();
    const rideResponse = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        rideType: RideType.COMMUTE,
        vehicleId: vehicle.id,
        source: 'Noida',
        destination: 'Dehradun',
        sourceLatitude: NOIDA.latitude,
        sourceLongitude: NOIDA.longitude,
        destinationLatitude: DEHRADUN.latitude,
        destinationLongitude: DEHRADUN.longitude,
        departureDate,
        departureTime: '09:00',
        totalSeats: 4,
        pricePerSeat: 100,
      })
      .expect(201);

    const stored = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: rideResponse.body.id });
    expect(stored.routePolyline).toBeTruthy();

    return { login, ride: rideResponse.body };
  }

  function corridorSearch(
    token: string,
    params: Record<string, string | number>,
  ) {
    return request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${token}`)
      .query(params);
  }

  it('returns routeMatchPercentage near 100 for exact same route', async () => {
    const { login, ride } = await publishCommuteNoidaDehradun();

    const res = await corridorSearch(login.accessToken, {
      source: 'Noida',
      destination: 'Dehradun',
      date: departureDate,
      rideType: RideType.COMMUTE,
      pickupLatitude: NOIDA.latitude,
      pickupLongitude: NOIDA.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    }).expect(200);

    const item = res.body.items.find(
      (row: { id: string }) => row.id === ride.id,
    );
    expect(item).toBeDefined();
    expect(item.routeMatchPercentage).toBeGreaterThanOrEqual(95);
    expect(item.routeMatchPercentage).toBeLessThanOrEqual(100);
    expect(item.riderPricePerSeat).toBe('110');
  });

  it('omits routeMatchPercentage when coordinates are not supplied', async () => {
    const { login, ride } = await publishCommuteNoidaDehradun();

    const res = await corridorSearch(login.accessToken, {
      source: 'Noida',
      destination: 'Dehradun',
      date: departureDate,
      rideType: RideType.COMMUTE,
    }).expect(200);

    const item = res.body.items.find(
      (row: { id: string }) => row.id === ride.id,
    );
    expect(item).toBeDefined();
    expect(item.routeMatchPercentage).toBeUndefined();
  });

  it('returns high routeMatchPercentage for on-route partial-to-end trip', async () => {
    const { login, ride } = await publishCommuteNoidaDehradun();

    const res = await corridorSearch(login.accessToken, {
      source: 'Indirapuram',
      destination: 'Dehradun',
      date: departureDate,
      rideType: RideType.COMMUTE,
      pickupLatitude: INDIRAPURAM.latitude,
      pickupLongitude: INDIRAPURAM.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    }).expect(200);

    const item = res.body.items.find(
      (row: { id: string }) => row.id === ride.id,
    );
    expect(item.routeMatchPercentage).toBeGreaterThanOrEqual(70);
  });

  it('returns lower routeMatchPercentage for shorter partial overlap', async () => {
    const { login, ride } = await publishCommuteNoidaDehradun();

    const full = await corridorSearch(login.accessToken, {
      source: 'Noida',
      destination: 'Dehradun',
      date: departureDate,
      rideType: RideType.COMMUTE,
      pickupLatitude: NOIDA.latitude,
      pickupLongitude: NOIDA.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    }).expect(200);

    const partial = await corridorSearch(login.accessToken, {
      source: 'Indirapuram',
      destination: 'Meerut',
      date: departureDate,
      rideType: RideType.COMMUTE,
      pickupLatitude: INDIRAPURAM.latitude,
      pickupLongitude: INDIRAPURAM.longitude,
      dropoffLatitude: MEERUT.latitude,
      dropoffLongitude: MEERUT.longitude,
    }).expect(200);

    const fullItem = full.body.items.find(
      (row: { id: string }) => row.id === ride.id,
    );
    const partialItem = partial.body.items.find(
      (row: { id: string }) => row.id === ride.id,
    );

    expect(fullItem.routeMatchPercentage).toBeGreaterThan(
      partialItem.routeMatchPercentage,
    );
  });

  it('does not expose routeMatchPercentage for REGULAR corridor search', async () => {
    const { login, vehicle } = await createDriver();
    const regular = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        rideType: RideType.REGULAR,
        vehicleId: vehicle.id,
        source: 'Noida',
        destination: 'Dehradun',
        sourceLatitude: NOIDA.latitude,
        sourceLongitude: NOIDA.longitude,
        destinationLatitude: DEHRADUN.latitude,
        destinationLongitude: DEHRADUN.longitude,
        departureDate,
        departureTime: '09:00',
        totalSeats: 4,
        pricePerSeat: 250,
      })
      .expect(201);

    const res = await corridorSearch(login.accessToken, {
      source: 'Noida',
      destination: 'Dehradun',
      date: departureDate,
      rideType: RideType.REGULAR,
      pickupLatitude: NOIDA.latitude,
      pickupLongitude: NOIDA.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    }).expect(200);

    const item = res.body.items.find(
      (row: { id: string }) => row.id === regular.body.id,
    );
    expect(item).toBeDefined();
    expect(item.routeMatchPercentage).toBeUndefined();
  });

  it('reverse direction still excluded from corridor search', async () => {
    const { login, ride } = await publishCommuteNoidaDehradun();

    const res = await corridorSearch(login.accessToken, {
      source: 'Dehradun',
      destination: 'Meerut',
      date: departureDate,
      rideType: RideType.COMMUTE,
      pickupLatitude: DEHRADUN.latitude,
      pickupLongitude: DEHRADUN.longitude,
      dropoffLatitude: MEERUT.latitude,
      dropoffLongitude: MEERUT.longitude,
    }).expect(200);

    expect(
      res.body.items.map((row: { id: string }) => row.id),
    ).not.toContain(ride.id);
  });
});
