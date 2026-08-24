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

const NOIDA = { latitude: 28.5355, longitude: 77.391 };
const INDIRAPURAM = { latitude: 28.6415, longitude: 77.372 };
const MEERUT = { latitude: 28.9845, longitude: 77.7064 };
const DEHRADUN = { latitude: 30.3165, longitude: 78.0322 };
const MUMBAI = { latitude: 19.076, longitude: 72.8777 };

describe('Regular ride route-corridor search (GET /rides/search)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  const tracked: TestWalletContext[] = [];
  const departureDate = '2026-09-15';

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

  async function publishNoidaDehradun(options?: {
    totalSeats?: number;
    availableSeats?: number;
    rideType?: RideType;
    date?: string;
  }) {
    const login = await createAuthenticatedUser();
    await dataSource.getRepository(UserProfile).save(
      dataSource.getRepository(UserProfile).create({
        userId: login.user.id,
        firstName: 'Route',
        lastName: 'Driver',
        displayName: 'Route Driver',
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
      registrationNumber: `UP14${Date.now().toString().slice(-6)}${Math.floor(
        Math.random() * 10,
      )}`,
      registrationYear: 2024,
      color: 'White',
      seatingCapacity: 5,
    });
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
    await markVerified(login.user.id, VerificationType.VEHICLE);

    const totalSeats = options?.totalSeats ?? 4;
    const rideResponse = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        rideType: options?.rideType ?? RideType.REGULAR,
        vehicleId: vehicle.id,
        source: 'Noida',
        destination: 'Dehradun',
        sourceLatitude: NOIDA.latitude,
        sourceLongitude: NOIDA.longitude,
        destinationLatitude: DEHRADUN.latitude,
        destinationLongitude: DEHRADUN.longitude,
        departureDate: options?.date ?? departureDate,
        departureTime: '09:00',
        totalSeats,
        pricePerSeat: 250,
      })
      .expect(201);

    if (options?.availableSeats !== undefined) {
      await dataSource.getRepository(Ride).update(rideResponse.body.id, {
        availableSeats: options.availableSeats,
      });
    }

    const stored = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: rideResponse.body.id });
    expect(stored.routePolyline).toBeTruthy();
    expect(stored.routeBboxMinLat).not.toBeNull();

    return { login, ride: rideResponse.body as { id: string } };
  }

  function searchQuery(
    token: string,
    params: Record<string, string | number>,
  ) {
    return request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${token}`)
      .query(params);
  }

  it('Test 1: published Noida → Dehradun matches exact coordinate search', async () => {
    const { login, ride } = await publishNoidaDehradun();
    const res = await searchQuery(login.accessToken, {
      source: 'Noida',
      destination: 'Dehradun',
      date: departureDate,
      pickupLatitude: NOIDA.latitude,
      pickupLongitude: NOIDA.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    }).expect(200);

    expect(res.body.items.map((item: { id: string }) => item.id)).toContain(
      ride.id,
    );
  });

  it('Test 2: Indirapuram → Dehradun matches corridor search', async () => {
    const { login, ride } = await publishNoidaDehradun();
    const res = await searchQuery(login.accessToken, {
      source: 'Indirapuram',
      destination: 'Dehradun',
      date: departureDate,
      pickupLatitude: INDIRAPURAM.latitude,
      pickupLongitude: INDIRAPURAM.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    }).expect(200);

    expect(res.body.items.map((item: { id: string }) => item.id)).toContain(
      ride.id,
    );
  });

  it('Test 3: Noida → Meerut matches when Meerut is on/near the route', async () => {
    const { login, ride } = await publishNoidaDehradun();
    const res = await searchQuery(login.accessToken, {
      source: 'Noida',
      destination: 'Meerut',
      date: departureDate,
      pickupLatitude: NOIDA.latitude,
      pickupLongitude: NOIDA.longitude,
      dropoffLatitude: MEERUT.latitude,
      dropoffLongitude: MEERUT.longitude,
    }).expect(200);

    expect(res.body.items.map((item: { id: string }) => item.id)).toContain(
      ride.id,
    );
  });

  it('Test 4: Meerut → Dehradun matches', async () => {
    const { login, ride } = await publishNoidaDehradun();
    const res = await searchQuery(login.accessToken, {
      source: 'Meerut',
      destination: 'Dehradun',
      date: departureDate,
      pickupLatitude: MEERUT.latitude,
      pickupLongitude: MEERUT.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    }).expect(200);

    expect(res.body.items.map((item: { id: string }) => item.id)).toContain(
      ride.id,
    );
  });

  it('Test 5: Dehradun → Meerut does not match (reversed)', async () => {
    const { login, ride } = await publishNoidaDehradun();
    const res = await searchQuery(login.accessToken, {
      source: 'Dehradun',
      destination: 'Meerut',
      date: departureDate,
      pickupLatitude: DEHRADUN.latitude,
      pickupLongitude: DEHRADUN.longitude,
      dropoffLatitude: MEERUT.latitude,
      dropoffLongitude: MEERUT.longitude,
    }).expect(200);

    expect(res.body.items.map((item: { id: string }) => item.id)).not.toContain(
      ride.id,
    );
  });

  it('Test 6: pickup > 50km from route does not match', async () => {
    const { login, ride } = await publishNoidaDehradun();
    const res = await searchQuery(login.accessToken, {
      source: 'Mumbai',
      destination: 'Dehradun',
      date: departureDate,
      pickupLatitude: MUMBAI.latitude,
      pickupLongitude: MUMBAI.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    }).expect(200);

    expect(res.body.items.map((item: { id: string }) => item.id)).not.toContain(
      ride.id,
    );
  });

  it('Test 7: destination > 50km from route does not match', async () => {
    const { login, ride } = await publishNoidaDehradun();
    const res = await searchQuery(login.accessToken, {
      source: 'Noida',
      destination: 'Mumbai',
      date: departureDate,
      pickupLatitude: NOIDA.latitude,
      pickupLongitude: NOIDA.longitude,
      dropoffLatitude: MUMBAI.latitude,
      dropoffLongitude: MUMBAI.longitude,
    }).expect(200);

    expect(res.body.items.map((item: { id: string }) => item.id)).not.toContain(
      ride.id,
    );
  });

  it('Test 8: Indirapuram → Meerut within corridor matches', async () => {
    const { login, ride } = await publishNoidaDehradun();
    const res = await searchQuery(login.accessToken, {
      source: 'Indirapuram',
      destination: 'Meerut',
      date: departureDate,
      pickupLatitude: INDIRAPURAM.latitude,
      pickupLongitude: INDIRAPURAM.longitude,
      dropoffLatitude: MEERUT.latitude,
      dropoffLongitude: MEERUT.longitude,
    }).expect(200);

    expect(res.body.items.map((item: { id: string }) => item.id)).toContain(
      ride.id,
    );
  });

  it('Test 9: exact place-name search without coordinates still matches', async () => {
    const { login, ride } = await publishNoidaDehradun();
    const res = await searchQuery(login.accessToken, {
      source: 'Noida',
      destination: 'Dehradun',
      date: departureDate,
    }).expect(200);

    expect(res.body.items.map((item: { id: string }) => item.id)).toContain(
      ride.id,
    );
  });

  it('Test 10: insufficient seats does not match', async () => {
    const { login, ride } = await publishNoidaDehradun({
      totalSeats: 2,
      availableSeats: 1,
    });
    const res = await searchQuery(login.accessToken, {
      source: 'Noida',
      destination: 'Dehradun',
      date: departureDate,
      seats: 2,
      pickupLatitude: NOIDA.latitude,
      pickupLongitude: NOIDA.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    }).expect(200);

    expect(res.body.items.map((item: { id: string }) => item.id)).not.toContain(
      ride.id,
    );
  });

  it('Test 11: different date does not match', async () => {
    const { login, ride } = await publishNoidaDehradun();
    const res = await searchQuery(login.accessToken, {
      source: 'Noida',
      destination: 'Dehradun',
      date: '2026-09-16',
      pickupLatitude: NOIDA.latitude,
      pickupLongitude: NOIDA.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    }).expect(200);

    expect(res.body.items.map((item: { id: string }) => item.id)).not.toContain(
      ride.id,
    );
  });

  it('Test 12: rideType filter preserves Regular vs Assured separation', async () => {
    const { login, ride } = await publishNoidaDehradun({
      rideType: RideType.REGULAR,
    });
    const assuredOnly = await searchQuery(login.accessToken, {
      source: 'Noida',
      destination: 'Dehradun',
      date: departureDate,
      rideType: RideType.ASSURED,
      pickupLatitude: NOIDA.latitude,
      pickupLongitude: NOIDA.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    }).expect(200);

    expect(
      assuredOnly.body.items.map((item: { id: string }) => item.id),
    ).not.toContain(ride.id);

    const regularOnly = await searchQuery(login.accessToken, {
      source: 'Noida',
      destination: 'Dehradun',
      date: departureDate,
      rideType: RideType.REGULAR,
      pickupLatitude: NOIDA.latitude,
      pickupLongitude: NOIDA.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    }).expect(200);

    expect(
      regularOnly.body.items.map((item: { id: string }) => item.id),
    ).toContain(ride.id);
  });

  it('updates route geometry when source/destination coordinates change before bookings', async () => {
    const { login, ride } = await publishNoidaDehradun();

    await request(app.getHttpServer())
      .patch(`/rides/${ride.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        source: 'Meerut',
        destination: 'Dehradun',
        sourceLatitude: MEERUT.latitude,
        sourceLongitude: MEERUT.longitude,
        destinationLatitude: DEHRADUN.latitude,
        destinationLongitude: DEHRADUN.longitude,
      })
      .expect(200);

    const stored = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(stored.source).toBe('Meerut');
    expect(stored.sourceLatitude).toBeCloseTo(MEERUT.latitude, 4);
    expect(stored.routePolyline).toBeTruthy();

    const noidaSearch = await searchQuery(login.accessToken, {
      source: 'Noida',
      destination: 'Dehradun',
      date: departureDate,
      pickupLatitude: NOIDA.latitude,
      pickupLongitude: NOIDA.longitude,
      dropoffLatitude: DEHRADUN.latitude,
      dropoffLongitude: DEHRADUN.longitude,
    }).expect(200);

    // Noida is now well before the published Meerut→Dehradun corridor start.
    expect(
      noidaSearch.body.items.map((item: { id: string }) => item.id),
    ).not.toContain(ride.id);
  });
});
