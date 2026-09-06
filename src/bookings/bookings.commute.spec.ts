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
import { deleteChatForBookingIds } from '../chat/test/chat-test.helpers';
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
  WalletTransactionDirection,
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
import { Ride } from '../rides/entities/ride.entity';
import { RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import { BookingsModule } from './bookings.module';
import { Booking } from './entities/booking.entity';
import {
  BookingCancellationReason,
  BookingMode,
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingStatus,
} from './enums/booking.enums';

describe('Commute booking request lifecycle (integration)', () => {
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
        const bookings = await dataSource.getRepository(Booking).find({
          where: [{ passengerId: ctx.userId }],
          select: { id: true },
        });
        const asDriverRides = await dataSource.getRepository(Ride).find({
          where: { driverId: ctx.userId },
          select: { id: true },
        });
        const driverBookingIds =
          asDriverRides.length === 0
            ? []
            : (
                await dataSource.getRepository(Booking).find({
                  where: { rideId: In(asDriverRides.map((r) => r.id)) },
                  select: { id: true },
                })
              ).map((b) => b.id);
        await deleteChatForBookingIds(dataSource, [
          ...bookings.map((b) => b.id),
          ...driverBookingIds,
        ]);
        if (driverBookingIds.length > 0) {
          await dataSource
            .getRepository(Booking)
            .createQueryBuilder()
            .delete()
            .where('id IN (:...ids)', { ids: driverBookingIds })
            .execute();
        }
        await dataSource.getRepository(Booking).delete({
          passengerId: ctx.userId,
        });
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
        lastName: 'User',
        displayName: 'Commute User',
        gender: null,
        dateOfBirth: null,
        profilePhoto: 'https://cdn.example.com/user.jpg',
      }),
    );

    return { login, wallet, balance };
  }

  async function markVerified(userId: string, type: VerificationType) {
    await markVerificationVerified(
      verificationService,
      dataSource,
      userId,
      type,
    );
  }

  async function publishCommuteDriver(
    totalSeats = 4,
    pricePerSeat = 100,
    departureTime = '08:30',
  ) {
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
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
    await markVerified(login.user.id, VerificationType.VEHICLE);

    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: 10000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('commute-driver-fund'),
    });

    const rideResponse = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        rideType: RideType.COMMUTE,
        vehicleId: vehicle.id,
        source: 'Gurgaon Cyber City',
        destination: 'Noida Sector 62',
        departureDate: '2026-09-01',
        departureTime,
        totalSeats,
        pricePerSeat,
        notes: 'Office commute',
      })
      .expect(201);

    return { login, wallet, ride: rideResponse.body };
  }

  async function fundedPassenger(creditAmount: bigint) {
    const { login, wallet, balance } = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);

    if (creditAmount > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: creditAmount,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('commute-passenger-fund'),
      });
    }

    return { login, wallet, balance };
  }

  async function createCommuteBooking(
    accessToken: string,
    rideId: string,
    seats: number,
    idempotencyKey = uniqueIdempotencyKey('commute-book'),
  ) {
    return request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        rideId,
        seats,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);
  }

  it('A–E: creates PENDING Commute booking with rider fare debit and snapshots', async () => {
    const { login: driver, wallet: driverWallet, ride } =
      await publishCommuteDriver(4, 100);
    const { login: passenger, wallet } = await fundedPassenger(1000n);

    const balanceBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });

    const response = await createCommuteBooking(
      passenger.accessToken,
      ride.id,
      2,
    );

    expect(response.body).toMatchObject({
      status: BookingStatus.PENDING,
      paymentStatus: BookingPaymentStatus.PAID,
      paymentMethod: BookingPaymentMethod.PAY_NOW,
      bookingMode: BookingMode.COMMUTE,
      seats: 2,
      pricePerSeatSnapshot: '110',
      riderPricePerSeatSnapshot: '110',
      driverPricePerSeatSnapshot: '100',
      totalAmount: '220',
      driverShareAmount: '200',
      platformShareAmount: '20',
    });
    expect(response.body.platformFee).toBeUndefined();

    const balanceAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(BigInt(balanceBefore.purchasedAvailable) - BigInt(balanceAfter.purchasedAvailable)).toBe(
      220n,
    );

    const storedRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(storedRide.availableSeats).toBe(4);

    const driverWalletTx = await dataSource.getRepository(WalletTransaction).count({
      where: { walletId: driverWallet.id },
    });
    expect(driverWalletTx).toBe(1);
  });

  it('F–G: pending request does not reduce available seats for search', async () => {
    const { login: driver, ride } = await publishCommuteDriver(4, 100);
    const { login: passengerA } = await fundedPassenger(1000n);
    const { login: passengerB } = await fundedPassenger(1000n);

    await createCommuteBooking(passengerA.accessToken, ride.id, 2);

    const searchAfterA = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .query({
        source: 'Gurgaon',
        destination: 'Noida',
        date: '2026-09-01',
        rideType: RideType.COMMUTE,
      })
      .expect(200);

    expect(searchAfterA.body.items[0].availableSeats).toBe(4);

    await createCommuteBooking(passengerB.accessToken, ride.id, 2);

    const searchAfterB = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .query({
        source: 'Gurgaon',
        destination: 'Noida',
        date: '2026-09-01',
        rideType: RideType.COMMUTE,
      })
      .expect(200);

    expect(searchAfterB.body.items[0].availableSeats).toBe(4);
  });

  it('H–K: driver accepts PENDING request and decrements seats', async () => {
    const { login: driver, ride } = await publishCommuteDriver(4, 100);
    const { login: passenger } = await fundedPassenger(1000n);

    const booking = await createCommuteBooking(
      passenger.accessToken,
      ride.id,
      2,
    );

    const pendingList = await request(app.getHttpServer())
      .get('/bookings/driver/my-rides')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .query({ status: BookingStatus.PENDING })
      .expect(200);

    expect(pendingList.body.items).toHaveLength(1);
    expect(pendingList.body.items[0].id).toBe(booking.body.id);
    expect(pendingList.body.items[0].totalAmount).toBe('220');

    const accepted = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(accepted.body).toMatchObject({
      status: BookingStatus.CONFIRMED,
      paymentStatus: BookingPaymentStatus.PAID,
      alreadyApplied: false,
    });

    const storedRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(storedRide.availableSeats).toBe(2);

    const search = await request(app.getHttpServer())
      .get('/rides/search')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .query({
        source: 'Gurgaon',
        destination: 'Noida',
        date: '2026-09-01',
        rideType: RideType.COMMUTE,
      })
      .expect(200);
    expect(search.body.items[0].availableSeats).toBe(2);
  });

  it('L: accept is idempotent', async () => {
    const { login: driver, ride } = await publishCommuteDriver(4, 100);
    const { login: passenger } = await fundedPassenger(1000n);
    const booking = await createCommuteBooking(
      passenger.accessToken,
      ride.id,
      1,
    );

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const retry = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(retry.body.alreadyApplied).toBe(true);
    expect(retry.body.status).toBe(BookingStatus.CONFIRMED);

    const storedRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(storedRide.availableSeats).toBe(3);
  });

  it('M–P: driver reject refunds full rider amount without changing seats', async () => {
    const { login: driver, ride } = await publishCommuteDriver(4, 100);
    const { login: passenger, wallet } = await fundedPassenger(1000n);

    const booking = await createCommuteBooking(
      passenger.accessToken,
      ride.id,
      2,
    );

    const balanceAfterBook = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(balanceAfterBook.purchasedAvailable).toBe('780');

    const rejected = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/reject`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(rejected.body).toMatchObject({
      status: BookingStatus.CANCELLED,
      paymentStatus: BookingPaymentStatus.REFUNDED,
      alreadyApplied: false,
    });

    const storedBooking = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(storedBooking.cancellationReason).toBe(
      BookingCancellationReason.DRIVER_REJECTED,
    );

    const storedRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(storedRide.availableSeats).toBe(4);

    const balanceAfterReject = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(balanceAfterReject.purchasedAvailable).toBe('1000');

    const refundTx = await dataSource
      .getRepository(WalletTransaction)
      .findOneByOrFail({
        idempotencyKey: `commute:reject:${booking.body.id}`,
      });
    expect(refundTx.transactionType).toBe(WalletTransactionType.REFUND);
    expect(refundTx.direction).toBe(WalletTransactionDirection.CREDIT);
    expect(refundTx.amount).toBe('220');
  });

  it('Q: reject refund is idempotent', async () => {
    const { login: driver, ride } = await publishCommuteDriver(4, 100);
    const { login: passenger, wallet } = await fundedPassenger(1000n);
    const booking = await createCommuteBooking(
      passenger.accessToken,
      ride.id,
      1,
    );

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/reject`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const retry = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/reject`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(retry.body.alreadyApplied).toBe(true);

    const refundCount = await dataSource.getRepository(WalletTransaction).count({
      where: { idempotencyKey: `commute:reject:${booking.body.id}` },
    });
    expect(refundCount).toBe(1);

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(balance.purchasedAvailable).toBe('1000');
  });

  it('S–T: passenger cannot accept/reject; other driver cannot act', async () => {
    const { login: driver, ride } = await publishCommuteDriver(4, 100);
    const { login: passenger } = await fundedPassenger(1000n);
    const { login: otherDriver } = await publishCommuteDriver(4, 100);

    const booking = await createCommuteBooking(
      passenger.accessToken,
      ride.id,
      1,
    );

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/accept`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/reject`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/accept`)
      .set('Authorization', `Bearer ${otherDriver.accessToken}`)
      .expect(404);
  });

  it('U–V: cannot accept/reject non-PENDING bookings incorrectly', async () => {
    const { login: driver, ride } = await publishCommuteDriver(4, 100);
    const { login: passenger } = await fundedPassenger(1000n);
    const booking = await createCommuteBooking(
      passenger.accessToken,
      ride.id,
      1,
    );

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/reject`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(409);

    const booking2 = await createCommuteBooking(
      passenger.accessToken,
      ride.id,
      1,
    );

    await request(app.getHttpServer())
      .post(`/bookings/${booking2.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/bookings/${booking2.body.id}/reject`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(409);
  });

  it('W: concurrent pending accepts cannot overbook seats', async () => {
    const { login: driver, ride } = await publishCommuteDriver(4, 100);
    const { login: passengerA } = await fundedPassenger(5000n);
    const { login: passengerB } = await fundedPassenger(5000n);

    const bookingA = await createCommuteBooking(
      passengerA.accessToken,
      ride.id,
      3,
    );
    const bookingB = await createCommuteBooking(
      passengerB.accessToken,
      ride.id,
      3,
    );

    await request(app.getHttpServer())
      .post(`/bookings/${bookingA.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/bookings/${bookingB.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(409);

    const storedRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(storedRide.availableSeats).toBe(1);
  });

  it('passenger can cancel PENDING Commute booking with full refund', async () => {
    const { login: driver, ride } = await publishCommuteDriver(3, 100);
    const { login: passenger, wallet } = await fundedPassenger(1000n);

    const booking = await createCommuteBooking(
      passenger.accessToken,
      ride.id,
      1,
    );

    const balanceAfterBook = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });

    const cancelled = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/cancel`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);

    expect(cancelled.body).toMatchObject({
      status: BookingStatus.CANCELLED,
      paymentStatus: BookingPaymentStatus.REFUNDED,
      cancellationReason: BookingCancellationReason.RIDER_CANCELLED,
      seatsRestored: 0,
      fareRefunded: '110',
      alreadyApplied: false,
    });

    const storedRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(storedRide.availableSeats).toBe(3);

    const balanceAfterCancel = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(balanceAfterCancel.purchasedAvailable).toBe('1000');
  });
});
