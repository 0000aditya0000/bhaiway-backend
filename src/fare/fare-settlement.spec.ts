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
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingStatus,
  BookingFarePayment,
} from '../bookings/enums/booking.enums';
import {
  fareSettlementDriverCreditKey,
  fareSettlementPassengerDebitKey,
} from './fare-settlement.math';
import { SettingsModule } from '../settings/settings.module';
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
import {
  WalletHold,
  WalletHoldStatus,
} from '../wallet/entities/wallet-hold.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionDirection,
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
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import { ASSURED_TEST_ROUTE } from '../rides/test/assured-ride-test.helpers';
import { startRideAndVerifyAllPickups } from '../rides/test/ride-trip-test.helpers';

function pickupOtpPepper(): string {
  const secret = process.env.JWT_ACCESS_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new Error('JWT_ACCESS_SECRET is required for pickup OTP tests');
  }
  return secret;
}

describe('Fare settlement (integration)', () => {
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
        SettingsModule,
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
    return { login, wallet };
  }

  async function markVerified(userId: string, type: VerificationType) {
    await markVerificationVerified(
      verificationService,
      dataSource,
      userId,
      type,
    );
  }

  async function fundedDriver(credit = 10000n) {
    const { login, wallet } = await createAuthenticatedUser();
    const vehicle = await vehiclesService.create(login.user.id, {
      vehicleType: VehicleType.CAR,
      make: 'Honda',
      model: 'City',
      variant: 'ZX',
      registrationNumber: `MH12${Date.now().toString().slice(-6)}${Math.floor(
        Math.random() * 10,
      )}`,
      registrationYear: 2024,
      color: 'Blue',
      seatingCapacity: 5,
    });
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
    await markVerified(login.user.id, VerificationType.VEHICLE);
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: credit,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('fare-driver'),
    });
    return { login, wallet, vehicle };
  }

  async function fundedPassenger(credit = 10000n) {
    const { login, wallet } = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: credit,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('fare-pass'),
    });
    return { login, wallet };
  }

  async function publishRegular(
    driver: Awaited<ReturnType<typeof fundedDriver>>,
    pricePerSeat = 200,
    totalSeats = 4,
  ) {
    const response = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.REGULAR,
        vehicleId: driver.vehicle.id,
        source: 'Fare Source',
        destination: 'Fare Dest',
        departureDate: '2026-11-01',
        departureTime: '09:00',
        totalSeats,
        pricePerSeat,
      })
      .expect(201);
    return response.body as { id: string };
  }

  async function publishAssured(
    driver: Awaited<ReturnType<typeof fundedDriver>>,
    pricePerSeat = 500,
  ) {
    const response = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        ...ASSURED_TEST_ROUTE,
        vehicleId: driver.vehicle.id,
        source: 'Assured Fare Source',
        destination: 'Assured Fare Dest',
        departureDate: '2026-11-02',
        departureTime: '10:00',
        totalSeats: 4,
        pricePerSeat,
      })
      .expect(201);
    return response.body as { id: string; assuredDepositAmount: string };
  }

  it('Regular PAY_LATER: completion leaves fare UNPAID; passenger pays via wallet after', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(1000n);
    const ride = await publishRegular(driver, 200);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 2,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    const passengerBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: passenger.wallet.id });
    const driverBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driver.wallet.id });

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const bookingAfterComplete = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(bookingAfterComplete.paymentStatus).toBe(BookingPaymentStatus.UNPAID);
    expect(bookingAfterComplete.status).toBe(BookingStatus.COMPLETED);

    const passengerAfterComplete = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: passenger.wallet.id });
    const driverAfterComplete = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driver.wallet.id });
    expect(passengerAfterComplete.purchasedAvailable).toBe(
      passengerBefore.purchasedAvailable,
    );
    expect(driverAfterComplete.driverEarnedAvailable).toBe(
      driverBefore.driverEarnedAvailable,
    );

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/pay-wallet`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    const bookingRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(bookingRow.paymentStatus).toBe(BookingPaymentStatus.PAID);

    const passengerAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: passenger.wallet.id });
    const driverAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driver.wallet.id });

    expect(passengerAfter.purchasedAvailable).toBe(
      (BigInt(passengerBefore.purchasedAvailable) - 400n).toString(),
    );
    expect(driverAfter.driverEarnedAvailable).toBe(
      (BigInt(driverBefore.driverEarnedAvailable) + 400n).toString(),
    );

    const debit = await dataSource.getRepository(WalletTransaction).findOneByOrFail({
      idempotencyKey: fareSettlementPassengerDebitKey(booking.body.id),
    });
    expect(debit.transactionType).toBe(WalletTransactionType.BOOKING_PAYMENT);
    expect(debit.direction).toBe(WalletTransactionDirection.DEBIT);
    expect(debit.amount).toBe('400');

    const credit = await dataSource.getRepository(WalletTransaction).findOneByOrFail({
      idempotencyKey: fareSettlementDriverCreditKey(booking.body.id),
    });
    expect(credit.transactionType).toBe(WalletTransactionType.DRIVER_EARNING);
    expect(credit.direction).toBe(WalletTransactionDirection.CREDIT);
    expect(credit.amount).toBe('400');
  });

  it('Regular PAY_NOW: completion credits driver without second passenger debit', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(1000n);
    const ride = await publishRegular(driver, 150);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('pay-now-fare'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    const passengerAfterBooking = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: passenger.wallet.id });
    expect(passengerAfterBooking.purchasedAvailable).toBe('850');

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const passengerAfterComplete = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: passenger.wallet.id });
    expect(passengerAfterComplete.purchasedAvailable).toBe('850');

    const driverAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driver.wallet.id });
    expect(driverAfter.driverEarnedAvailable).toBe('150');

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          walletId: passenger.wallet.id,
          transactionType: WalletTransactionType.BOOKING_PAYMENT,
        },
      }),
    ).toBe(1);

    const credit = await dataSource.getRepository(WalletTransaction).findOneByOrFail({
      idempotencyKey: fareSettlementDriverCreditKey(booking.body.id),
    });
    expect(credit.amount).toBe('150');
  });

  it('PAY_NOW completion retry does not duplicate driver credit', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(500n);
    const ride = await publishRegular(driver, 100);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('pay-now-idem'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const second = await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);
    expect(second.body.alreadyCompleted).toBe(true);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          idempotencyKey: fareSettlementDriverCreditKey(booking.body.id),
        },
      }),
    ).toBe(1);
  });

  it('Assured ASSURED_DEPOSIT PAY_LATER: deposit and fare stay separate; fare paid post-trip', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(2000n);
    const ride = await publishAssured(driver, 500);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('assured-fare'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        farePayment: 'PAY_LATER',
      })
      .expect(201);

    expect(booking.body.securityDepositAmount).toBe('25');
    expect(booking.body.totalAmount).toBe('500');

    const bookingRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(bookingRow.assuredDepositAmount).toBe('25');
    expect(bookingRow.totalAmount).toBe('500');
    expect(bookingRow.paymentStatus).toBe(BookingPaymentStatus.UNPAID);

    const depositHoldId = bookingRow.walletHoldId!;

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const after = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(after.paymentStatus).toBe(BookingPaymentStatus.UNPAID);
    expect(after.status).toBe(BookingStatus.COMPLETED);

    const depositHold = await dataSource
      .getRepository(WalletHold)
      .findOneByOrFail({ id: depositHoldId });
    expect(depositHold.status).toBe(WalletHoldStatus.RELEASED);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          idempotencyKey: fareSettlementPassengerDebitKey(booking.body.id),
        },
      }),
    ).toBe(0);

    const pay = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/pay-wallet`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    expect(pay.body.fareAmount).toBe('500');
    expect(pay.body.passengerDebited).toBe('500');
    expect(pay.body.driverCredited).toBe('500');
    expect(pay.body.paymentChannel).toBe('WALLET');
    expect(pay.body.transactionId).toBeTruthy();

    const fareDebit = await dataSource
      .getRepository(WalletTransaction)
      .findOneByOrFail({
        idempotencyKey: fareSettlementPassengerDebitKey(booking.body.id),
      });
    expect(fareDebit.amount).toBe('500');
    expect(fareDebit.transactionType).toBe(WalletTransactionType.BOOKING_PAYMENT);

    const driverCredit = await dataSource
      .getRepository(WalletTransaction)
      .findOneByOrFail({
        idempotencyKey: fareSettlementDriverCreditKey(booking.body.id),
      });
    expect(driverCredit.amount).toBe('500');
    expect(driverCredit.transactionType).toBe(
      WalletTransactionType.DRIVER_EARNING,
    );

    expect(fareDebit.amount).not.toBe(bookingRow.assuredDepositAmount);

    const paidRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(paidRow.fareWalletTransactionId).toBe(fareDebit.id);
    expect(paidRow.walletTransactionId).toBe(bookingRow.walletTransactionId);
  });

  it('REGULAR PAY_LATER with insufficient balance: driver completes; wallet pay fails for passenger', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(100n);
    const ride = await publishRegular(driver, 200);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.id });
    expect(rideRow.status).toBe(RideStatus.COMPLETED);

    const bookingRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(bookingRow.paymentStatus).toBe(BookingPaymentStatus.UNPAID);
    expect(bookingRow.status).toBe(BookingStatus.COMPLETED);

    const driverBalance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driver.wallet.id });
    expect(driverBalance.driverEarnedAvailable).toBe('0');

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/pay-wallet`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(422);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/pay-cash`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    const afterCash = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(afterCash.paymentStatus).toBe(BookingPaymentStatus.PAID);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          idempotencyKey: fareSettlementDriverCreditKey(booking.body.id),
        },
      }),
    ).toBe(0);
  });

  it('mixed PAY_NOW + PAY_LATER on same ride settles all fares', async () => {
    const driver = await fundedDriver();
    const payNowPassenger = await fundedPassenger(1000n);
    const payLaterPassenger = await fundedPassenger(1000n);
    const ride = await publishRegular(driver, 100, 4);

    const payNowBooking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${payNowPassenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('mixed-now'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    const payLaterBooking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${payLaterPassenger.login.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 2,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const driverBalance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driver.wallet.id });
    expect(driverBalance.driverEarnedAvailable).toBe('100');

    const payLaterRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: payLaterBooking.body.id });
    expect(payLaterRow.paymentStatus).toBe(BookingPaymentStatus.UNPAID);

    const payNowRow = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: payNowBooking.body.id });
    expect(payNowRow.paymentStatus).toBe(BookingPaymentStatus.PAID);
    expect(payNowRow.status).toBe(BookingStatus.COMPLETED);
  });

  it('REGULAR PAY_LATER zero wallet: driver completes successfully', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(0n);
    const ride = await publishRegular(driver, 150);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const row = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(row.status).toBe(BookingStatus.COMPLETED);
    expect(row.paymentStatus).toBe(BookingPaymentStatus.UNPAID);
  });

  it('REGULAR PAY_LATER duplicate wallet payment is idempotent', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(500n);
    const ride = await publishRegular(driver, 100);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const first = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/pay-wallet`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(first.body.alreadySettled).toBe(false);

    const second = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/pay-wallet`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(second.body.alreadySettled).toBe(true);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          idempotencyKey: fareSettlementPassengerDebitKey(booking.body.id),
        },
      }),
    ).toBe(1);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          idempotencyKey: fareSettlementDriverCreditKey(booking.body.id),
        },
      }),
    ).toBe(1);
  });

  it('REGULAR PAY_LATER duplicate cash payment is idempotent', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(0n);
    const ride = await publishRegular(driver, 100);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const first = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/pay-cash`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(first.body.paymentChannel).toBe('CASH');
    expect(first.body.alreadySettled).toBe(false);

    const second = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/pay-cash`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(second.body.alreadySettled).toBe(true);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { referenceId: booking.body.id },
      }),
    ).toBe(0);
  });

  it('ASSURED PAY_LATER zero wallet: driver completes successfully', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(50n);
    const ride = await publishAssured(driver, 500);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('assured-zero'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        farePayment: BookingFarePayment.PAY_LATER,
      })
      .expect(201);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const row = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(row.status).toBe(BookingStatus.COMPLETED);
    expect(row.paymentStatus).toBe(BookingPaymentStatus.UNPAID);
  });

  it('ASSURED PAY_LATER insufficient balance: wallet pay fails; cash still works', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(100n);
    const ride = await publishAssured(driver, 500);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('assured-insuf'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        farePayment: BookingFarePayment.PAY_LATER,
      })
      .expect(201);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/pay-wallet`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(422);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/pay-cash`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          idempotencyKey: fareSettlementDriverCreditKey(booking.body.id),
        },
      }),
    ).toBe(0);
  });

  it('ASSURED PAY_LATER duplicate wallet payment is idempotent', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(2000n);
    const ride = await publishAssured(driver, 500);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('assured-dup'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        farePayment: BookingFarePayment.PAY_LATER,
      })
      .expect(201);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/pay-wallet`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);

    const second = await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/pay-wallet`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(200);
    expect(second.body.alreadySettled).toBe(true);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          idempotencyKey: fareSettlementPassengerDebitKey(booking.body.id),
        },
      }),
    ).toBe(1);
  });

  it('PAY_NOW bookings reject post-trip pay-wallet', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(2000n);
    const ride = await publishRegular(driver, 200);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('pay-now-reject'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_NOW,
      })
      .expect(201);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/pay-wallet`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(400);
  });

  it('ASSURED PAY_NOW rejects post-trip pay-wallet', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(5000n);
    const ride = await publishAssured(driver, 500);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('assured-now-reject'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        farePayment: BookingFarePayment.PAY_NOW,
      })
      .expect(201);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/pay-wallet`)
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .expect(400);
  });

  it('wrong passenger cannot pay PAY_LATER fare', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(1000n);
    const other = await fundedPassenger(1000n);
    const ride = await publishRegular(driver, 200);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/bookings/${booking.body.id}/pay-wallet`)
      .set('Authorization', `Bearer ${other.login.accessToken}`)
      .expect(404);
  });

  it('ASSURED PAY_NOW still credits driver at completion without post-trip payment', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(5000n);
    const ride = await publishAssured(driver, 500);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('assured-now-complete'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        farePayment: BookingFarePayment.PAY_NOW,
      })
      .expect(201);

    await startRideAndVerifyAllPickups(
      app,
      dataSource,
      driver.login.accessToken,
      ride.id,
      pickupOtpPepper(),
    );

    await request(app.getHttpServer())
      .post(`/rides/${ride.id}/complete`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .expect(200);

    const row = await dataSource
      .getRepository(Booking)
      .findOneByOrFail({ id: booking.body.id });
    expect(row.paymentStatus).toBe(BookingPaymentStatus.PAID);

    const driverCredit = await dataSource
      .getRepository(WalletTransaction)
      .findOneByOrFail({
        idempotencyKey: fareSettlementDriverCreditKey(booking.body.id),
      });
    expect(driverCredit.amount).toBe('500');
  });
});
