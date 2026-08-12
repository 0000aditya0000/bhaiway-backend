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

describe('Rides search (integration)', () => {
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
        firstName: 'Search',
        lastName: 'Driver',
        displayName: 'Search Driver',
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example.com/driver.jpg',
      }),
    );

    return login;
  }

  async function markVerified(userId: string, type: VerificationType) {
    if (type === VerificationType.IDENTITY) {
      await verificationService.submitIdentityVerification(userId, {
        documentType: `${type}_SCAN`,
      });
    } else if (type === VerificationType.DRIVING_LICENSE) {
      await verificationService.submitDrivingLicenseVerification(userId, {
        documentType: `${type}_SCAN`,
      });
    } else {
      await verificationService.submitVehicleVerification(userId, {
        documentType: `${type}_SCAN`,
      });
    }

    const record = await dataSource
      .getRepository(UserVerification)
      .findOneByOrFail({
        userId,
        verificationType: type,
        isCurrent: true,
      });

    await verificationService.applyTrustedVerificationDecision(record.id, {
      status: VerificationStatus.VERIFIED,
    });
  }

  async function publishableDriver() {
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

    const wallet = await dataSource.getRepository(Wallet).findOneByOrFail({
      userId: login.user.id,
    });
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: 10000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('search-driver-fund'),
    });

    return { login, vehicle };
  }

  async function createRide(
    accessToken: string,
    vehicleId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const response = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        rideType: RideType.REGULAR,
        vehicleId,
        source: 'Noida Sector 62',
        destination: 'Connaught Place, Delhi',
        departureDate: '2026-08-20',
        departureTime: '09:00',
        totalSeats: 3,
        pricePerSeat: 250,
        maxTwoInBackSeat: true,
        noSmoking: true,
        noPets: false,
        luggageAllowed: true,
        notes: 'AC car',
        ...overrides,
      })
      .expect(201);

    return response.body;
  }

  it('search requires JWT', async () => {
    await request(app.getHttpServer())
      .get('/rides/search')
      .query({
        source: 'Noida',
        destination: 'Delhi',
        date: '2026-08-20',
      })
      .expect(401);
  });

  it('returns only PUBLISHED rides', async () => {
    const { login, vehicle } = await publishableDriver();
    const published = await createRide(login.accessToken, vehicle.id);
    const cancelled = await createRide(login.accessToken, vehicle.id, {
      departureTime: '10:00',
      source: 'Noida Extension',
    });

    await dataSource.getRepository(Ride).update(
      { id: cancelled.id },
      { status: RideStatus.CANCELLED },
    );

    const response = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida',
        destination: 'Delhi',
        date: '2026-08-20',
      })
      .expect(200);

    const ids = response.body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(published.id);
    expect(ids).not.toContain(cancelled.id);
  });

  it('filters by date', async () => {
    const { login, vehicle } = await publishableDriver();
    const onDate = await createRide(login.accessToken, vehicle.id);
    await createRide(login.accessToken, vehicle.id, {
      departureDate: '2026-08-21',
      departureTime: '09:00',
    });

    const response = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida',
        destination: 'Delhi',
        date: '2026-08-20',
      })
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].id).toBe(onDate.id);
  });

  it('filters by time and returns rides at/after requested time', async () => {
    const { login, vehicle } = await publishableDriver();
    await createRide(login.accessToken, vehicle.id, { departureTime: '08:00' });
    const later = await createRide(login.accessToken, vehicle.id, {
      departureTime: '10:30',
    });
    const exact = await createRide(login.accessToken, vehicle.id, {
      departureTime: '09:00',
    });

    const response = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida',
        destination: 'Delhi',
        date: '2026-08-20',
        time: '09:00',
      })
      .expect(200);

    const ids = response.body.items.map((item: { id: string }) => item.id);
    expect(ids).toEqual(expect.arrayContaining([later.id, exact.id]));
    expect(ids).toHaveLength(2);
  });

  it('filters by available seats and excludes insufficient seats', async () => {
    const { login, vehicle } = await publishableDriver();
    const enough = await createRide(login.accessToken, vehicle.id, {
      totalSeats: 3,
      departureTime: '09:00',
    });
    const notEnough = await createRide(login.accessToken, vehicle.id, {
      totalSeats: 1,
      departureTime: '10:00',
    });

    const response = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida',
        destination: 'Delhi',
        date: '2026-08-20',
        seats: 2,
      })
      .expect(200);

    const ids = response.body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(enough.id);
    expect(ids).not.toContain(notEnough.id);
  });

  it('source matching is case-insensitive contains', async () => {
    const { login, vehicle } = await publishableDriver();
    const ride = await createRide(login.accessToken, vehicle.id, {
      source: 'Noida Sector 62',
    });

    const response = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'noida',
        destination: 'Delhi',
        date: '2026-08-20',
      })
      .expect(200);

    expect(response.body.items[0].id).toBe(ride.id);
  });

  it('destination matching is case-insensitive contains', async () => {
    const { login, vehicle } = await publishableDriver();
    const ride = await createRide(login.accessToken, vehicle.id, {
      destination: 'Connaught Place, Delhi',
    });

    const response = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida',
        destination: 'delhi',
        date: '2026-08-20',
      })
      .expect(200);

    expect(response.body.items[0].id).toBe(ride.id);
  });

  it('REGULAR and ASSURED rideType filters work; omitted returns both', async () => {
    const { login, vehicle } = await publishableDriver();
    await createRide(login.accessToken, vehicle.id, {
      rideType: RideType.REGULAR,
      source: 'Noida Filter A',
    });
    await createRide(login.accessToken, vehicle.id, {
      rideType: RideType.ASSURED,
      source: 'Noida Filter B',
      departureTime: '10:00',
    });

    const regular = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida Filter',
        destination: 'Delhi',
        date: '2026-08-20',
        rideType: RideType.REGULAR,
      })
      .expect(200);
    expect(regular.body.items).toHaveLength(1);
    expect(regular.body.items[0].rideType).toBe(RideType.REGULAR);

    const assured = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida Filter',
        destination: 'Delhi',
        date: '2026-08-20',
        rideType: RideType.ASSURED,
      })
      .expect(200);
    expect(assured.body.items).toHaveLength(1);
    expect(assured.body.items[0].rideType).toBe(RideType.ASSURED);

    const both = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida Filter',
        destination: 'Delhi',
        date: '2026-08-20',
      })
      .expect(200);
    expect(both.body.items).toHaveLength(2);
  });

  it('pagination defaults and max limit work with correct total', async () => {
    const { login, vehicle } = await publishableDriver();

    for (let i = 0; i < 3; i += 1) {
      await createRide(login.accessToken, vehicle.id, {
        departureTime: `${9 + i}`.padStart(2, '0') + ':00',
        source: `Noida Point ${i}`,
      });
    }

    const defaults = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida',
        destination: 'Delhi',
        date: '2026-08-20',
      })
      .expect(200);

    expect(defaults.body.page).toBe(1);
    expect(defaults.body.limit).toBe(20);
    expect(defaults.body.total).toBe(3);
    expect(defaults.body.totalPages).toBe(1);

    const page1 = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida',
        destination: 'Delhi',
        date: '2026-08-20',
        page: 1,
        limit: 2,
      })
      .expect(200);

    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.total).toBe(3);
    expect(page1.body.totalPages).toBe(2);

    await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida',
        destination: 'Delhi',
        date: '2026-08-20',
        limit: 51,
      })
      .expect(400);
  });

  it('sorting is departure_date, departure_time, created_at ASC', async () => {
    const { login, vehicle } = await publishableDriver();
    const mid = await createRide(login.accessToken, vehicle.id, {
      departureTime: '11:00',
      source: 'Noida A',
    });
    const early = await createRide(login.accessToken, vehicle.id, {
      departureTime: '08:00',
      source: 'Noida B',
    });
    const late = await createRide(login.accessToken, vehicle.id, {
      departureTime: '13:00',
      source: 'Noida C',
    });

    const response = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida',
        destination: 'Delhi',
        date: '2026-08-20',
      })
      .expect(200);

    expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([
      early.id,
      mid.id,
      late.id,
    ]);
  });

  it('search is read-only', async () => {
    const { login, vehicle } = await publishableDriver();
    const ride = await createRide(login.accessToken, vehicle.id);
    const before = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });

    await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida',
        destination: 'Delhi',
        date: '2026-08-20',
        seats: 1,
      })
      .expect(200);

    const after = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(after.availableSeats).toBe(before.availableSeats);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('returns safe driver and vehicle fields without secrets', async () => {
    const { login, vehicle } = await publishableDriver();
    await createRide(login.accessToken, vehicle.id);

    const response = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .query({
        source: 'Noida',
        destination: 'Delhi',
        date: '2026-08-20',
      })
      .expect(200);

    const item = response.body.items[0];
    expect(item.driver).toEqual({
      id: login.user.id,
      displayName: 'Search Driver',
      profilePhoto: 'https://cdn.example.com/driver.jpg',
    });
    expect(item.vehicle).toMatchObject({
      id: vehicle.id,
      vehicleType: VehicleType.CAR,
      make: 'Honda',
      model: 'City',
      variant: 'ZX',
      color: 'White',
      seatingCapacity: 5,
    });

    expect(item.phone).toBeUndefined();
    expect(item.email).toBeUndefined();
    expect(item.driver.phone).toBeUndefined();
    expect(item.driver.email).toBeUndefined();
    expect(item.wallet).toBeUndefined();
    expect(item.vehicle.documentUrl).toBeUndefined();
    expect(item.vehicle.documentType).toBeUndefined();
    expect(item.vehicle.documentReference).toBeUndefined();
    expect(item.vehicle.registrationNumber).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain(login.user.phone);
  });

  it('GET /rides/public/:id returns published ride only', async () => {
    const owner = await publishableDriver();
    const stranger = await createAuthenticatedUser();
    const ride = await createRide(owner.login.accessToken, owner.vehicle.id);

    const publicView = await request(app.getHttpServer())
      .get(`/rides/public/${ride.id}`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .expect(200);

    expect(publicView.body.id).toBe(ride.id);
    expect(publicView.body.driver.phone).toBeUndefined();
    expect(publicView.body.vehicle.documentUrl).toBeUndefined();

    await dataSource.getRepository(Ride).update(
      { id: ride.id },
      { status: RideStatus.CANCELLED },
    );

    await request(app.getHttpServer())
      .get(`/rides/public/${ride.id}`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .expect(404);

    // Owner-only endpoint still finds cancelled ride for owner
    await request(app.getHttpServer())
      .get(`/rides/${ride.id}`)
      .set('Authorization', `Bearer ${owner.login.accessToken}`)
      .expect(200);
  });

  it('owner-only GET /rides/:id still hides other drivers rides', async () => {
    const owner = await publishableDriver();
    const other = await publishableDriver();
    const ride = await createRide(owner.login.accessToken, owner.vehicle.id);

    await request(app.getHttpServer())
      .get(`/rides/${ride.id}`)
      .set('Authorization', `Bearer ${other.login.accessToken}`)
      .expect(404);
  });
});
