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
import { BookingStatus } from '../bookings/enums/booking.enums';
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
import { WalletService } from '../wallet/wallet.service';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  creditTestWalletPoints,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';
import { Ride } from './entities/ride.entity';
import { RideStatus, RideType } from './enums/ride.enums';
import { RidesModule } from './rides.module';

describe('Past ride history (integration)', () => {
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

  async function publishableDriver(totalSeats = 3) {
    const login = await createAuthenticatedUser();
    await dataSource.getRepository(UserProfile).save(
      dataSource.getRepository(UserProfile).create({
        userId: login.user.id,
        firstName: 'History',
        lastName: 'Driver',
        displayName: 'History Driver',
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example.com/driver.jpg',
      }),
    );

    const vehicle = await vehiclesService.create(login.user.id, {
      vehicleType: VehicleType.CAR,
      make: 'Tata',
      model: 'Nexon',
      variant: 'XZ+',
      registrationNumber: `DL${Date.now().toString().slice(-8)}`,
      registrationYear: 2024,
      color: 'Black',
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
        pricePerSeat: 150,
      })
      .expect(201);

    return { login, vehicle, ride: rideResponse.body };
  }

  async function verifiedPassenger(displayName: string) {
    const login = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await dataSource.getRepository(UserProfile).save(
      dataSource.getRepository(UserProfile).create({
        userId: login.user.id,
        firstName: displayName.split(' ')[0] ?? 'Passenger',
        lastName: displayName.split(' ')[1] ?? null,
        displayName,
        gender: null,
        dateOfBirth: null,
        profilePhoto: `https://cdn.example.com/${displayName.replace(/\s+/g, '-').toLowerCase()}.jpg`,
      }),
    );
    const wallet = await dataSource.getRepository(Wallet).findOneByOrFail({
      userId: login.user.id,
    });
    await creditTestWalletPoints(
      walletService,
      wallet.id,
      login.user.id,
      10000n,
      'history-passenger',
    );
    return login;
  }

  async function bookAndCompleteRide() {
    const { login: driver, ride, vehicle } = await publishableDriver(3);
    const p1 = await verifiedPassenger('Amit S');
    const p2 = await verifiedPassenger('Sneha K');

    const b1 = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${p1.accessToken}`)
      .send({ rideId: ride.id, seats: 1, paymentMethod: 'PAY_LATER' })
      .expect(201);

    const b2 = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${p2.accessToken}`)
      .send({ rideId: ride.id, seats: 1, paymentMethod: 'PAY_LATER' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/start`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    for (const [passenger, booking] of [
      [p1, b1] as const,
      [p2, b2] as const,
    ]) {
      const otp = (
        await request(app.getHttpServer())
          .get('/bookings/my')
          .set('Authorization', `Bearer ${passenger.accessToken}`)
          .expect(200)
      ).body.find((row: { id: string }) => row.id === booking.body.id)
        .pickupOtp;

      await request(app.getHttpServer())
        .post(`/bookings/${booking.body.id}/verify-pickup`)
        .set('Authorization', `Bearer ${driver.accessToken}`)
        .send({ otp })
        .expect(200);
    }

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    return { driver, ride, vehicle, p1, p2, b1: b1.body, b2: b2.body };
  }

  it('1–2: driver retrieves own completed ride history; cannot access another driver ride', async () => {
    const completed = await bookAndCompleteRide();
    const other = await publishableDriver(2);

    const list = await request(app.getHttpServer())
      .get('/rides/history')
      .set('Authorization', `Bearer ${completed.driver.accessToken}`)
      .expect(200);

    expect(list.body.page).toBe(1);
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);
    const item = list.body.items.find(
      (row: { ride: { id: string } }) => row.ride.id === completed.ride.id,
    );
    expect(item).toBeTruthy();
    expect(item.ride.status).toBe(RideStatus.COMPLETED);
    expect(item.ride.sourceLatitude).toBeNull();
    expect(item.ride.distanceKm).toBeNull();
    expect(item.earnings.passengerTotal).toBe('300');
    expect(item.earnings.assuredBonus).toBeNull();
    expect(item.earnings.total).toBe('300');

    const detail = await request(app.getHttpServer())
      .get(`/rides/history/${completed.ride.id}`)
      .set('Authorization', `Bearer ${completed.driver.accessToken}`)
      .expect(200);

    expect(detail.body.passengers).toHaveLength(2);
    const names = detail.body.passengers.map(
      (p: { name: string }) => p.name,
    );
    expect(names).toEqual(expect.arrayContaining(['Amit S', 'Sneha K']));
    expect(
      detail.body.passengers.every(
        (p: { fare: string }) => p.fare === '150',
      ),
    ).toBe(true);
    expect(detail.body.vehicle.registrationNumber).toBe(
      completed.vehicle.registrationNumber,
    );
    expect(detail.body.vehicle.name).toContain('Tata');

    await request(app.getHttpServer())
      .get(`/rides/history/${completed.ride.id}`)
      .set('Authorization', `Bearer ${other.login.accessToken}`)
      .expect(404);
  });

  it('3–4: passenger retrieves own completed booking; cannot access another passenger booking', async () => {
    const completed = await bookAndCompleteRide();

    const list = await request(app.getHttpServer())
      .get('/bookings/history')
      .set('Authorization', `Bearer ${completed.p1.accessToken}`)
      .expect(200);

    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].trip.bookingId).toBe(completed.b1.id);
    expect(list.body.items[0].trip.bookingStatus).toBe(
      BookingStatus.COMPLETED,
    );
    expect(list.body.items[0].fare.rideFare).toBe('150');
    expect(list.body.items[0].driver.name).toBe('History Driver');
    expect(list.body.items[0].vehicle.make).toBe('Tata');
    expect(list.body.items[0].trip.sourceLatitude).toBeNull();
    expect(list.body.items[0].fare.platformFee).toBeNull();

    const detail = await request(app.getHttpServer())
      .get(`/bookings/history/${completed.b1.id}`)
      .set('Authorization', `Bearer ${completed.p1.accessToken}`)
      .expect(200);

    expect(detail.body.invoice.invoiceId).toBeNull();
    expect(detail.body.payment.paymentMethod).toBe('PAY_LATER');
    expect(detail.body.payment.paymentStatus).toBe('PAID');
    expect(detail.body.fare.totalPaid).toBe('150');

    await request(app.getHttpServer())
      .get(`/bookings/history/${completed.b1.id}`)
      .set('Authorization', `Bearer ${completed.p2.accessToken}`)
      .expect(404);
  });

  it('5–6: completed appears in history; published does not', async () => {
    const { login, ride } = await publishableDriver(2);

    const before = await request(app.getHttpServer())
      .get('/rides/history')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);
    expect(
      before.body.items.some(
        (row: { ride: { id: string } }) => row.ride.id === ride.id,
      ),
    ).toBe(false);

    const completed = await bookAndCompleteRide();
    const after = await request(app.getHttpServer())
      .get('/rides/history')
      .query({ status: RideStatus.COMPLETED })
      .set('Authorization', `Bearer ${completed.driver.accessToken}`)
      .expect(200);
    expect(
      after.body.items.some(
        (row: { ride: { id: string } }) => row.ride.id === completed.ride.id,
      ),
    ).toBe(true);
  });

  it('7: cancelled ride appears in driver history with zero completed earnings', async () => {
    const { login, ride } = await publishableDriver(2);
    const passenger = await verifiedPassenger('Cancel Rider');
    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ rideId: ride.id, seats: 1, paymentMethod: 'PAY_LATER' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/cancel`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    const history = await request(app.getHttpServer())
      .get('/rides/history')
      .query({ status: RideStatus.CANCELLED })
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    const item = history.body.items.find(
      (row: { ride: { id: string } }) => row.ride.id === ride.id,
    );
    expect(item).toBeTruthy();
    expect(item.ride.status).toBe(RideStatus.CANCELLED);
    expect(item.earnings.passengerTotal).toBe('0');
    expect(item.ride.cancelledAt).toBeTruthy();

    const passengerHistory = await request(app.getHttpServer())
      .get('/bookings/history')
      .query({ status: BookingStatus.CANCELLED })
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(passengerHistory.body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('8–10: earnings and rider fare use real booking amounts; no fake invoice/coords', async () => {
    const completed = await bookAndCompleteRide();

    const detail = await request(app.getHttpServer())
      .get(`/rides/history/${completed.ride.id}`)
      .set('Authorization', `Bearer ${completed.driver.accessToken}`)
      .expect(200);

    const sum = detail.body.passengers.reduce(
      (acc: bigint, p: { fare: string }) => acc + BigInt(p.fare),
      0n,
    );
    expect(detail.body.earnings.passengerTotal).toBe(sum.toString());
    expect(detail.body.earnings.total).toBe('300');
    expect(detail.body.ride.startedAt).toBeNull();
    expect(detail.body.ride.completedAt).toBeNull();
    expect(detail.body.ride.durationMinutes).toBeNull();
    expect(JSON.stringify(detail.body)).not.toMatch(/INV-/);

    const rider = await request(app.getHttpServer())
      .get(`/bookings/history/${completed.b2.id}`)
      .set('Authorization', `Bearer ${completed.p2.accessToken}`)
      .expect(200);
    expect(rider.body.fare.rideFare).toBe('150');
    expect(rider.body.fare.taxes).toBeNull();
    expect(rider.body.invoice.invoiceId).toBeNull();
    expect(rider.body.trip.destinationLongitude).toBeNull();
  });

  it('11–12: pagination and empty history work', async () => {
    const emptyDriver = await publishableDriver(2);
    const empty = await request(app.getHttpServer())
      .get('/rides/history')
      .set('Authorization', `Bearer ${emptyDriver.login.accessToken}`)
      .expect(200);
    expect(empty.body.items).toEqual([]);
    expect(empty.body.total).toBe(0);
    expect(empty.body.totalPages).toBe(0);

    const completed = await bookAndCompleteRide();
    const page = await request(app.getHttpServer())
      .get('/rides/history')
      .query({ page: 1, limit: 1 })
      .set('Authorization', `Bearer ${completed.driver.accessToken}`)
      .expect(200);
    expect(page.body.limit).toBe(1);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.total).toBeGreaterThanOrEqual(1);
  });

  it('13–14: no fake map coordinates; IN_PROGRESS excluded from past history', async () => {
    const { login, ride } = await publishableDriver(2);
    await dataSource
      .getRepository(Ride)
      .update({ id: ride.id }, { status: RideStatus.IN_PROGRESS });

    const history = await request(app.getHttpServer())
      .get('/rides/history')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);
    expect(
      history.body.items.some(
        (row: { ride: { id: string } }) => row.ride.id === ride.id,
      ),
    ).toBe(false);

    await request(app.getHttpServer())
      .get(`/rides/history/${ride.id}`)
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(404);
  });
});
