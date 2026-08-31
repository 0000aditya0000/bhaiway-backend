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
import { RideStatus, RideType } from './enums/ride.enums';
import { RidesModule } from './rides.module';
import { ASSURED_TEST_ROUTE } from './test/assured-ride-test.helpers';

describe('Daily Office Commute (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  const tracked: TestWalletContext[] = [];

  const COMMUTE_PUBLISH_BODY = {
    rideType: RideType.COMMUTE,
    source: 'Gurgaon Cyber City',
    destination: 'Noida Sector 62',
    departureDate: '2026-09-01',
    departureTime: '08:30',
    totalSeats: 3,
    pricePerSeat: 100,
    maxTwoInBackSeat: true,
    noSmoking: true,
    noPets: false,
    luggageAllowed: true,
    notes: 'Office commute',
  };

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
        firstName: 'Commute',
        lastName: 'Driver',
        displayName: 'Commute Driver',
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example.com/driver.jpg',
      }),
    );

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
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
    await markVerified(login.user.id, VerificationType.VEHICLE);

    const wallet = await dataSource.getRepository(Wallet).findOneByOrFail({
      userId: login.user.id,
    });
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: 10000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('commute-driver-fund'),
    });

    return { login, vehicle };
  }

  async function publishRide(
    accessToken: string,
    vehicleId: string,
    overrides: Record<string, unknown> = {},
    expectedStatus = 201,
  ) {
    const rideType =
      (overrides.rideType as RideType | undefined) ?? RideType.COMMUTE;
    return request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${accessToken}`)
      .set(
        'Idempotency-Key',
        uniqueIdempotencyKey(`commute-publish-${rideType}`),
      )
      .send({
        vehicleId,
        ...(rideType === RideType.ASSURED ? ASSURED_TEST_ROUTE : {}),
        ...COMMUTE_PUBLISH_BODY,
        ...overrides,
        rideType,
      })
      .expect(expectedStatus);
  }

  it('A: COMMUTE ride can be created', async () => {
    const { login, vehicle } = await publishableDriver();

    const response = await publishRide(login.accessToken, vehicle.id);

    expect(response.body.rideType).toBe(RideType.COMMUTE);
    expect(response.body.status).toBe(RideStatus.PUBLISHED);
  });

  it('B: REGULAR ride creation still works', async () => {
    const { login, vehicle } = await publishableDriver();

    const response = await publishRide(login.accessToken, vehicle.id, {
      rideType: RideType.REGULAR,
      source: 'Noida Sector 62',
      destination: 'Connaught Place, Delhi',
      departureDate: '2026-08-20',
      departureTime: '09:00',
      pricePerSeat: 250,
    });

    expect(response.body.rideType).toBe(RideType.REGULAR);
    expect(response.body.riderPricePerSeat).toBeUndefined();
  });

  it('C: ASSURED ride creation still works', async () => {
    const { login, vehicle } = await publishableDriver();

    const response = await publishRide(login.accessToken, vehicle.id, {
      rideType: RideType.ASSURED,
      source: 'Noida Sector 62',
      destination: 'Connaught Place, Delhi',
      departureDate: '2026-08-20',
      departureTime: '09:00',
      totalSeats: 1,
      pricePerSeat: 500,
    });

    expect(response.body.rideType).toBe(RideType.ASSURED);
    expect(response.body.riderPricePerSeat).toBeUndefined();
  });

  it('D–F: driver fare stored; rider fare computed for several values', async () => {
    const { login, vehicle } = await publishableDriver();
    const cases = [
      { driver: 100, rider: '110' },
      { driver: 250, rider: '275' },
      { driver: 500, rider: '550' },
      { driver: 700, rider: '770' },
      { driver: 333, rider: '366' },
    ];

    for (const [index, testCase] of cases.entries()) {
      const response = await publishRide(login.accessToken, vehicle.id, {
        pricePerSeat: testCase.driver,
        departureTime: `${String(8 + index).padStart(2, '0')}:00`,
        source: `Gurgaon Point ${index}`,
      });

      expect(response.body.pricePerSeat).toBe(String(testCase.driver));
      expect(response.body.riderPricePerSeat).toBe(testCase.rider);

      const stored = await dataSource.getRepository(Ride).findOneByOrFail({
        id: response.body.id,
      });
      expect(stored.pricePerSeat).toBe(String(testCase.driver));
    }
  });

  it('G: multi-seat Commute ride sets availableSeats = totalSeats', async () => {
    const { login, vehicle } = await publishableDriver();

    const response = await publishRide(login.accessToken, vehicle.id, {
      totalSeats: 4,
    });

    expect(response.body.totalSeats).toBe(4);
    expect(response.body.availableSeats).toBe(4);
  });

  it('H–I: Commute search returns COMMUTE rides with rider-facing fare', async () => {
    const { login, vehicle } = await publishableDriver();
    const ride = await publishRide(login.accessToken, vehicle.id, {
      pricePerSeat: 100,
      source: 'Gurgaon Commute Search',
    });

    const search = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Gurgaon Commute',
        destination: 'Noida',
        date: '2026-09-01',
        rideType: RideType.COMMUTE,
      })
      .expect(200);

    expect(search.body.items).toHaveLength(1);
    expect(search.body.items[0].id).toBe(ride.body.id);
    expect(search.body.items[0].rideType).toBe(RideType.COMMUTE);
    expect(search.body.items[0].pricePerSeat).toBe('100');
    expect(search.body.items[0].riderPricePerSeat).toBe('110');
  });

  it('J: public Commute ride detail returns correct rider fare', async () => {
    const { login, vehicle } = await publishableDriver();
    const ride = await publishRide(login.accessToken, vehicle.id, {
      pricePerSeat: 100,
    });

    const publicView = await request(app.getHttpServer())
      .get(`/rides/public/${ride.body.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(publicView.body.rideType).toBe(RideType.COMMUTE);
    expect(publicView.body.pricePerSeat).toBe('100');
    expect(publicView.body.riderPricePerSeat).toBe('110');
  });

  it('K: Regular search remains unchanged (no riderPricePerSeat)', async () => {
    const { login, vehicle } = await publishableDriver();

    await publishRide(login.accessToken, vehicle.id, {
      rideType: RideType.REGULAR,
      source: 'Noida Regular Commute Test',
      destination: 'Delhi',
      departureDate: '2026-08-20',
      departureTime: '09:00',
      pricePerSeat: 250,
    });

    const search = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida Regular Commute',
        destination: 'Delhi',
        date: '2026-08-20',
        rideType: RideType.REGULAR,
      })
      .expect(200);

    expect(search.body.items).toHaveLength(1);
    expect(search.body.items[0].rideType).toBe(RideType.REGULAR);
    expect(search.body.items[0].pricePerSeat).toBe('250');
    expect(search.body.items[0].riderPricePerSeat).toBeUndefined();
  });

  it('L: Assured search remains unchanged (no riderPricePerSeat)', async () => {
    const { login, vehicle } = await publishableDriver();

    await publishRide(login.accessToken, vehicle.id, {
      rideType: RideType.ASSURED,
      source: 'Noida Assured Commute Test',
      destination: 'Delhi',
      departureDate: '2026-08-20',
      departureTime: '09:00',
      totalSeats: 1,
      pricePerSeat: 500,
    });

    const search = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida Assured Commute',
        destination: 'Delhi',
        date: '2026-08-20',
        rideType: RideType.ASSURED,
      })
      .expect(200);

    expect(search.body.items).toHaveLength(1);
    expect(search.body.items[0].rideType).toBe(RideType.ASSURED);
    expect(search.body.items[0].riderPricePerSeat).toBeUndefined();
    expect(search.body.items[0].assuredDepositAmount).toBeTruthy();
  });

  it('O: Commute responses do not expose platformFee', async () => {
    const { login, vehicle } = await publishableDriver();
    const ride = await publishRide(login.accessToken, vehicle.id);

    const search = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Gurgaon',
        destination: 'Noida',
        date: '2026-09-01',
        rideType: RideType.COMMUTE,
      })
      .expect(200);

    const publicView = await request(app.getHttpServer())
      .get(`/rides/public/${ride.body.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    for (const payload of [ride.body, search.body.items[0], publicView.body]) {
      expect(payload.platformFee).toBeUndefined();
      expect(payload.platformFeeAmount).toBeUndefined();
    }
  });
});
