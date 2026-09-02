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
import {
  BookingCancellationReason,
  BookingMode,
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import {
  commuteSettlementDriverCreditKey,
  commuteSettlementPlatformMarginKey,
} from '../fare/commute-settlement.math';
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
import {
  PLATFORM_WALLET_ID,
} from '../wallet/platform-wallet.constants';
import { WalletModule } from '../wallet/wallet.module';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletService } from '../wallet/wallet.service';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import { startRideAndVerifyAllPickups } from './test/ride-trip-test.helpers';

function pickupOtpPepper(): string {
  const secret = process.env.JWT_ACCESS_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new Error('JWT_ACCESS_SECRET is required for pickup OTP tests');
  }
  return secret;
}

describe('Commute completion settlement (integration)', () => {
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
        profilePhoto: null,
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

  async function publishCommuteDriver(totalSeats = 4, pricePerSeat = 100) {
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
        departureTime: '08:30',
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

  async function bookAccept(
    driverToken: string,
    passengerToken: string,
    rideId: string,
    seats: number,
  ) {
    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passengerToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('commute-settle-book'))
      .send({
        rideId,
        seats,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/accept`)
      .set('Authorization', `Bearer ${driverToken}`)
      .expect(200);

    return booking.body;
  }

  async function startCommuteTrip(driverToken: string, rideId: string) {
    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driverToken,
      rideId,
      pickupOtpPepper(),
    );
  }

  it('A–E: one-seat completion credits driver ₹100 and BhaiWay ₹10; no passenger debit', async () => {
    const { login: driver, wallet: driverWallet, ride } =
      await publishCommuteDriver(4, 100);
    const { login: passenger, wallet: passengerWallet } =
      await fundedPassenger(1000n);

    const booking = await bookAccept(
      driver.accessToken,
      passenger.accessToken,
      ride.id,
      1,
    );

    const passengerAfterBook = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: passengerWallet.id });
    expect(passengerAfterBook.purchasedAvailable).toBe('890');

    const driverBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driverWallet.id });
    const platformBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: PLATFORM_WALLET_ID });

    const passengerTxBefore = await dataSource
      .getRepository(WalletTransaction)
      .count({ where: { walletId: passengerWallet.id } });

    await startCommuteTrip(driver.accessToken, ride.id);

    const complete = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(complete.body).toMatchObject({
      status: RideStatus.COMPLETED,
      rideType: RideType.COMMUTE,
      commuteSettlement: {
        settledBookingCount: 1,
        driverSettlementTotal: '100',
        platformMarginTotal: '10',
      },
    });

    const driverAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driverWallet.id });
    const platformAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: PLATFORM_WALLET_ID });

    expect(
      BigInt(driverAfter.driverEarnedAvailable) -
        BigInt(driverBefore.driverEarnedAvailable),
    ).toBe(100n);
    expect(
      BigInt(platformAfter.purchasedAvailable) -
        BigInt(platformBefore.purchasedAvailable),
    ).toBe(10n);

    const passengerAfterComplete = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: passengerWallet.id });
    expect(passengerAfterComplete.purchasedAvailable).toBe('890');

    const passengerTxAfter = await dataSource
      .getRepository(WalletTransaction)
      .count({ where: { walletId: passengerWallet.id } });
    expect(passengerTxAfter).toBe(passengerTxBefore);

    const driverTx = await dataSource
      .getRepository(WalletTransaction)
      .findOneByOrFail({
        idempotencyKey: commuteSettlementDriverCreditKey(booking.id),
      });
    expect(driverTx.transactionType).toBe(
      WalletTransactionType.DRIVER_EARNING,
    );
    expect(driverTx.amount).toBe('100');
    expect(driverTx.direction).toBe(WalletTransactionDirection.CREDIT);

    const platformTx = await dataSource
      .getRepository(WalletTransaction)
      .findOneByOrFail({
        idempotencyKey: commuteSettlementPlatformMarginKey(booking.id),
      });
    expect(platformTx.transactionType).toBe(
      WalletTransactionType.COMMUTE_PLATFORM_MARGIN,
    );
    expect(platformTx.amount).toBe('10');

    const stored = await dataSource.getRepository(Booking).findOneByOrFail({
      id: booking.id,
    });
    expect(stored.status).toBe(BookingStatus.COMPLETED);
    expect(stored.paymentStatus).toBe(BookingPaymentStatus.PAID);
    expect(stored.settledAt).not.toBeNull();
    expect(stored.bookingMode).toBe(BookingMode.COMMUTE);
    expect(stored.paymentMethod).toBe(BookingPaymentMethod.PAY_NOW);
  });

  it('B: two-seat booking settles driver ₹200 and platform ₹20', async () => {
    const { login: driver, ride } = await publishCommuteDriver(4, 100);
    const { login: passenger } = await fundedPassenger(1000n);
    const booking = await bookAccept(
      driver.accessToken,
      passenger.accessToken,
      ride.id,
      2,
    );

    await startCommuteTrip(driver.accessToken, ride.id);

    const complete = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(complete.body.commuteSettlement).toEqual({
      settledBookingCount: 1,
      driverSettlementTotal: '200',
      platformMarginTotal: '20',
    });

    const stored = await dataSource.getRepository(Booking).findOneByOrFail({
      id: booking.id,
    });
    expect(stored.driverShareAmount).toBe('200');
    expect(stored.platformShareAmount).toBe('20');
    expect(stored.totalAmount).toBe('220');
  });

  it('F–I: pending and cancelled bookings are not settled', async () => {
    const { login: driver, ride } = await publishCommuteDriver(4, 100);
    const { login: passengerA } = await fundedPassenger(5000n);
    const { login: passengerB } = await fundedPassenger(5000n);
    const { login: passengerC } = await fundedPassenger(5000n);

    const confirmed = await bookAccept(
      driver.accessToken,
      passengerA.accessToken,
      ride.id,
      1,
    );

    const pending = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passengerB.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('pending'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    const rejected = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passengerC.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('reject'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/bookings/${rejected.body.id}/reject`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    await startCommuteTrip(driver.accessToken, ride.id);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const confirmedRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: confirmed.id });
    expect(confirmedRow.status).toBe(BookingStatus.COMPLETED);
    expect(confirmedRow.settledAt).not.toBeNull();

    const pendingRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: pending.body.id });
    expect(pendingRow.status).toBe(BookingStatus.PENDING);
    expect(pendingRow.settledAt).toBeNull();

    const rejectedRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: rejected.body.id });
    expect(rejectedRow.status).toBe(BookingStatus.CANCELLED);
    expect(rejectedRow.cancellationReason).toBe(
      BookingCancellationReason.DRIVER_REJECTED,
    );
    expect(rejectedRow.settledAt).toBeNull();

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          idempotencyKey: commuteSettlementDriverCreditKey(pending.body.id),
        },
      }),
    ).toBe(0);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          idempotencyKey: commuteSettlementDriverCreditKey(rejected.body.id),
        },
      }),
    ).toBe(0);
  });

  it('N–O: completion retry is idempotent (no double credit)', async () => {
    const { login: driver, wallet: driverWallet, ride } =
      await publishCommuteDriver(4, 100);
    const { login: passenger } = await fundedPassenger(1000n);
    const booking = await bookAccept(
      driver.accessToken,
      passenger.accessToken,
      ride.id,
      1,
    );

    await startCommuteTrip(driver.accessToken, ride.id);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const driverAfterFirst = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driverWallet.id });

    const retry = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(retry.body.alreadyCompleted).toBe(true);
    expect(retry.body.commuteSettlement).toMatchObject({
      settledBookingCount: 1,
      driverSettlementTotal: '100',
      platformMarginTotal: '10',
    });

    const driverAfterRetry = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driverWallet.id });
    expect(driverAfterRetry.driverEarnedAvailable).toBe(
      driverAfterFirst.driverEarnedAvailable,
    );

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          idempotencyKey: commuteSettlementDriverCreditKey(booking.id),
        },
      }),
    ).toBe(1);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          idempotencyKey: commuteSettlementPlatformMarginKey(booking.id),
        },
      }),
    ).toBe(1);
  });

  it('R: multiple confirmed bookings settle with correct totals', async () => {
    const { login: driver, ride } = await publishCommuteDriver(4, 100);
    const { login: passengerA } = await fundedPassenger(5000n);
    const { login: passengerB } = await fundedPassenger(5000n);

    await bookAccept(driver.accessToken, passengerA.accessToken, ride.id, 2);
    await bookAccept(driver.accessToken, passengerB.accessToken, ride.id, 1);

    await startCommuteTrip(driver.accessToken, ride.id);

    const complete = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    expect(complete.body.commuteSettlement).toEqual({
      settledBookingCount: 2,
      driverSettlementTotal: '300',
      platformMarginTotal: '30',
    });
  });

  it('T–U: only the owning driver can complete', async () => {
    const { login: driver, ride } = await publishCommuteDriver(4, 100);
    const { login: passenger } = await fundedPassenger(1000n);
    const { login: otherDriver } = await publishCommuteDriver(4, 100);

    await bookAccept(driver.accessToken, passenger.accessToken, ride.id, 1);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${otherDriver.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(409);

    await startCommuteTrip(driver.accessToken, ride.id);

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
  });
});
