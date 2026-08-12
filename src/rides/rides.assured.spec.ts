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
import { BookingPaymentMethod, BookingPaymentStatus } from '../bookings/enums/booking.enums';
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
import { WalletHold } from '../wallet/entities/wallet-hold.entity';
import {
  WalletTransaction,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import { SettingsModule } from '../settings/settings.module';
import { SettingsService } from '../settings/settings.service';
import { Ride } from './entities/ride.entity';
import { RideStatus, RideType } from './enums/ride.enums';
import { RidesModule } from './rides.module';

describe('Assured Ride Phase 1 (integration)', () => {
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
        SettingsModule,
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

  async function createAuthenticatedUser(displayName = 'Assured Driver') {
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
        firstName: 'Assured',
        lastName: 'User',
        displayName,
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example.com/assured.jpg',
      }),
    );

    return { login, wallet, phone };
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

  async function createVehicle(userId: string) {
    return vehiclesService.create(userId, {
      vehicleType: VehicleType.CAR,
      make: 'Toyota',
      model: 'Innova',
      variant: 'Crysta',
      registrationNumber: `DL01${Date.now().toString().slice(-6)}${Math.floor(
        Math.random() * 10,
      )}`,
      registrationYear: 2023,
      color: 'Silver',
      seatingCapacity: 6,
    });
  }

  async function publishableDriver(creditAmount = 5000n) {
    const { login, wallet } = await createAuthenticatedUser();
    const vehicle = await createVehicle(login.user.id);
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
    await markVerified(login.user.id, VerificationType.VEHICLE);
    if (creditAmount > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: creditAmount,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('driver-fund'),
      });
    }
    return { login, wallet, vehicle };
  }

  function assuredPayload(
    vehicleId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      rideType: RideType.ASSURED,
      vehicleId,
      source: 'Noida Assured Hub',
      destination: 'Delhi Assured Dest',
      departureDate: '2026-08-21',
      departureTime: '08:30',
      totalSeats: 3,
      pricePerSeat: 300,
      maxTwoInBackSeat: true,
      noSmoking: true,
      noPets: true,
      luggageAllowed: true,
      notes: 'Assured ride',
      ...overrides,
    };
  }

  async function verifiedPassenger(credit = 0n) {
    const { login, wallet } = await createAuthenticatedUser('Passenger');
    await markVerified(login.user.id, VerificationType.IDENTITY);
    if (credit > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: credit,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('assured-fund'),
      });
    }
    return { login, wallet };
  }

  describe('publishing', () => {
    it('verified driver can create ASSURED ride with deposit hold', async () => {
      const { login, vehicle, wallet } = await publishableDriver();

      const response = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send(assuredPayload(vehicle.id))
        .expect(201);

      // 3 × 300 × 5% = 45
      expect(response.body).toMatchObject({
        rideType: RideType.ASSURED,
        status: RideStatus.PUBLISHED,
        availableSeats: 3,
        totalSeats: 3,
        pricePerSeat: '300',
        driverId: login.user.id,
        assuredDepositPercentage: 5,
        assuredDepositAmount: '45',
      });

      const hold = await dataSource.getRepository(WalletHold).findOneByOrFail({
        walletId: wallet.id,
      });
      expect(hold.holdType).toBe('ASSURED_DEPOSIT');
      expect(hold.amount).toBe('45');
      expect(hold.status).toBe('ACTIVE');

      const tx = await dataSource
        .getRepository(WalletTransaction)
        .findOneByOrFail({
          walletId: wallet.id,
          transactionType: WalletTransactionType.ASSURED_DEPOSIT_HOLD,
        });
      expect(tx.direction).toBe('DEBIT');
      expect(tx.amount).toBe('45');
    });

    it('unverified / missing identity / DL / vehicle cannot create ASSURED', async () => {
      const unverified = await createAuthenticatedUser();
      const vehicleA = await createVehicle(unverified.login.user.id);
      await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${unverified.login.accessToken}`)
        .send(assuredPayload(vehicleA.id))
        .expect(403);

      const noIdentity = await createAuthenticatedUser();
      const vehicleB = await createVehicle(noIdentity.login.user.id);
      await markVerified(noIdentity.login.user.id, VerificationType.DRIVING_LICENSE);
      await markVerified(noIdentity.login.user.id, VerificationType.VEHICLE);
      await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${noIdentity.login.accessToken}`)
        .send(assuredPayload(vehicleB.id))
        .expect(403);

      const noDl = await createAuthenticatedUser();
      const vehicleC = await createVehicle(noDl.login.user.id);
      await markVerified(noDl.login.user.id, VerificationType.IDENTITY);
      await markVerified(noDl.login.user.id, VerificationType.VEHICLE);
      await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${noDl.login.accessToken}`)
        .send(assuredPayload(vehicleC.id))
        .expect(403);

      const noVehicle = await createAuthenticatedUser();
      const vehicleD = await createVehicle(noVehicle.login.user.id);
      await markVerified(noVehicle.login.user.id, VerificationType.IDENTITY);
      await markVerified(
        noVehicle.login.user.id,
        VerificationType.DRIVING_LICENSE,
      );
      await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${noVehicle.login.accessToken}`)
        .send(assuredPayload(vehicleD.id))
        .expect(403);
    });

    it('requires owned active vehicle; ignores client driverId/status/availableSeats', async () => {
      const driver = await publishableDriver();
      const other = await publishableDriver();

      await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${driver.login.accessToken}`)
        .send(assuredPayload(other.vehicle.id))
        .expect(403);

      const response = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${driver.login.accessToken}`)
        .send(
          assuredPayload(driver.vehicle.id, {
            driverId: other.login.user.id,
            status: RideStatus.DRAFT,
            availableSeats: 1,
          }),
        )
        .expect(400);
      expect(response.body.message).toBeDefined();
    });
  });

  describe('search and public detail', () => {
    it('search filters Assured/Regular/both and excludes unpublished/cancelled', async () => {
      const { login, vehicle } = await publishableDriver();

      const regular = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send(
          assuredPayload(vehicle.id, {
            rideType: RideType.REGULAR,
            source: 'Noida Phase1 Search',
            departureTime: '07:00',
          }),
        )
        .expect(201);

      const assured = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send(
          assuredPayload(vehicle.id, {
            source: 'Noida Phase1 Search',
            departureTime: '09:00',
            totalSeats: 4,
          }),
        )
        .expect(201);

      const draft = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send(
          assuredPayload(vehicle.id, {
            source: 'Noida Phase1 Search',
            departureTime: '10:00',
          }),
        )
        .expect(201);
      await dataSource
        .getRepository(Ride)
        .update({ id: draft.body.id }, { status: RideStatus.DRAFT });

      const cancelled = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send(
          assuredPayload(vehicle.id, {
            source: 'Noida Phase1 Search',
            departureTime: '11:00',
          }),
        )
        .expect(201);
      await dataSource
        .getRepository(Ride)
        .update({ id: cancelled.body.id }, { status: RideStatus.CANCELLED });

      const both = await request(app.getHttpServer())
        .get('/rides/search')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .query({
          source: 'Noida Phase1 Search',
          destination: 'Delhi',
          date: '2026-08-21',
        })
        .expect(200);
      expect(both.body.items).toHaveLength(2);
      expect(both.body.items.map((item: { id: string }) => item.id).sort()).toEqual(
        [regular.body.id, assured.body.id].sort(),
      );

      const onlyAssured = await request(app.getHttpServer())
        .get('/rides/search')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .query({
          source: 'Noida Phase1 Search',
          destination: 'Delhi',
          date: '2026-08-21',
          rideType: RideType.ASSURED,
        })
        .expect(200);
      expect(onlyAssured.body.items).toHaveLength(1);
      expect(onlyAssured.body.items[0].id).toBe(assured.body.id);

      const onlyRegular = await request(app.getHttpServer())
        .get('/rides/search')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .query({
          source: 'Noida Phase1 Search',
          destination: 'Delhi',
          date: '2026-08-21',
          rideType: RideType.REGULAR,
        })
        .expect(200);
      expect(onlyRegular.body.items).toHaveLength(1);
      expect(onlyRegular.body.items[0].id).toBe(regular.body.id);

      const byTime = await request(app.getHttpServer())
        .get('/rides/search')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .query({
          source: 'Noida Phase1 Search',
          destination: 'Delhi',
          date: '2026-08-21',
          time: '08:00',
        })
        .expect(200);
      expect(byTime.body.items).toHaveLength(1);
      expect(byTime.body.items[0].id).toBe(assured.body.id);

      const bySeats = await request(app.getHttpServer())
        .get('/rides/search')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .query({
          source: 'Noida Phase1 Search',
          destination: 'Delhi',
          date: '2026-08-21',
          seats: 4,
        })
        .expect(200);
      expect(bySeats.body.items).toHaveLength(1);
      expect(bySeats.body.items[0].id).toBe(assured.body.id);

      const wrongDate = await request(app.getHttpServer())
        .get('/rides/search')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .query({
          source: 'Noida Phase1 Search',
          destination: 'Delhi',
          date: '2026-08-22',
        })
        .expect(200);
      expect(wrongDate.body.items).toHaveLength(0);

      const page1 = await request(app.getHttpServer())
        .get('/rides/search')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .query({
          source: 'Noida Phase1 Search',
          destination: 'Delhi',
          date: '2026-08-21',
          page: 1,
          limit: 1,
        })
        .expect(200);
      expect(page1.body.items).toHaveLength(1);
      expect(page1.body.total).toBe(2);
      expect(page1.body.totalPages).toBe(2);
      expect(page1.body.items[0].departureTime <= '09:00:00').toBe(true);

      const seatsBefore = (
        await dataSource.getRepository(Ride).findOneByOrFail({
          id: assured.body.id,
        })
      ).availableSeats;
      await request(app.getHttpServer())
        .get('/rides/search')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .query({
          source: 'Noida Phase1 Search',
          destination: 'Delhi',
          date: '2026-08-21',
        })
        .expect(200);
      const seatsAfter = (
        await dataSource.getRepository(Ride).findOneByOrFail({
          id: assured.body.id,
        })
      ).availableSeats;
      expect(seatsAfter).toBe(seatsBefore);
    });

    it('public detail returns published Assured safely; hides draft/cancelled and secrets', async () => {
      const { login, phone, wallet } = await createAuthenticatedUser();
      const createdVehicle = await createVehicle(login.user.id);
      await markVerified(login.user.id, VerificationType.IDENTITY);
      await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
      await markVerified(login.user.id, VerificationType.VEHICLE);
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: 5000n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('public-driver-fund'),
      });

      const published = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send(assuredPayload(createdVehicle.id))
        .expect(201);

      const detail = await request(app.getHttpServer())
        .get(`/rides/public/${published.body.id}`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(detail.body.rideType).toBe(RideType.ASSURED);
      expect(detail.body.driver).toMatchObject({
        id: login.user.id,
        displayName: 'Assured Driver',
      });
      expect(detail.body.vehicle).toMatchObject({
        id: createdVehicle.id,
        make: 'Toyota',
        model: 'Innova',
      });
      expect(detail.body).not.toHaveProperty('driverId');
      expect(JSON.stringify(detail.body)).not.toContain(phone);
      expect(detail.body).not.toHaveProperty('wallet');
      expect(detail.body).not.toHaveProperty('email');
      expect(detail.body.driver).not.toHaveProperty('phone');
      expect(detail.body.vehicle).not.toHaveProperty('registrationNumber');
      expect(detail.body).not.toHaveProperty('deposit');
      expect(detail.body).not.toHaveProperty('securityDeposit');

      const draft = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send(
          assuredPayload(createdVehicle.id, {
            departureTime: '12:00',
          }),
        )
        .expect(201);
      await dataSource
        .getRepository(Ride)
        .update({ id: draft.body.id }, { status: RideStatus.DRAFT });
      await request(app.getHttpServer())
        .get(`/rides/public/${draft.body.id}`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(404);

      const cancelled = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .send(
          assuredPayload(createdVehicle.id, {
            departureTime: '13:00',
          }),
        )
        .expect(201);
      await dataSource
        .getRepository(Ride)
        .update({ id: cancelled.body.id }, { status: RideStatus.CANCELLED });
      await request(app.getHttpServer())
        .get(`/rides/public/${cancelled.body.id}`)
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(404);
    });
  });

  describe('booking boundary', () => {
    it('Assured deposit booking works; PAY_LATER/PAY_NOW rejected; Regular unchanged', async () => {
      const driver = await publishableDriver();
      const passenger = await verifiedPassenger(1000n);

      const assured = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${driver.login.accessToken}`)
        .send(
          assuredPayload(driver.vehicle.id, {
            pricePerSeat: 500,
            totalSeats: 4,
          }),
        )
        .expect(201);
      expect(assured.body.assuredDepositAmount).toBe('100');

      const regular = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${driver.login.accessToken}`)
        .send(
          assuredPayload(driver.vehicle.id, {
            rideType: RideType.REGULAR,
            departureTime: '14:00',
            source: 'Noida Regular Hub',
            pricePerSeat: 200,
          }),
        )
        .expect(201);

      await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .send({
          rideId: assured.body.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_LATER,
        })
        .expect(409);

      await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('assured-pay-now'))
        .send({
          rideId: assured.body.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_NOW,
        })
        .expect(409);

      const booked = await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('assured-dep'))
        .send({
          rideId: assured.body.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        })
        .expect(201);

      expect(booked.body).toMatchObject({
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        paymentStatus: BookingPaymentStatus.UNPAID,
        totalAmount: '500',
        securityDepositAmount: '25',
        securityDepositPercentage: 5,
      });

      const hold = await dataSource.getRepository(WalletHold).findOneByOrFail({
        walletId: passenger.wallet.id,
      });
      expect(hold.holdType).toBe('ASSURED_DEPOSIT');
      expect(hold.amount).toBe('25');

      const bookingPayments = await dataSource
        .getRepository(WalletTransaction)
        .count({
          where: {
            walletId: passenger.wallet.id,
            transactionType: WalletTransactionType.BOOKING_PAYMENT,
          },
        });
      expect(bookingPayments).toBe(0);

      await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .send({
          rideId: regular.body.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_LATER,
        })
        .expect(201);

      const otherPassenger = await verifiedPassenger(1000n);
      await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${otherPassenger.login.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('regular-now'))
        .send({
          rideId: regular.body.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_NOW,
        })
        .expect(201);
    });
  });
});
