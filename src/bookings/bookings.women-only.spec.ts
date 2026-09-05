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
import { Ride } from '../rides/entities/ride.entity';
import { RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import {
  ASSURED_TEST_ROUTE,
  withAssuredPublishHeaders,
} from '../rides/test/assured-ride-test.helpers';
import { SettingsModule } from '../settings/settings.module';
import { Gender, UserProfile } from '../users/entities/user-profile.entity';
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
  WalletHoldType,
} from '../wallet/entities/wallet-hold.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import {
  WalletTransaction,
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
import { BookingsModule } from './bookings.module';
import { Booking } from './entities/booking.entity';
import {
  BookingFarePayment,
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingStatus,
} from './enums/booking.enums';

describe('Women Only ride booking (integration)', () => {
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
        SettingsModule,
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
      if (!ctx) {
        continue;
      }
      await dataSource.getRepository(Booking).delete({ passengerId: ctx.userId });
      const rides = await dataSource.getRepository(Ride).find({
        where: { driverId: ctx.userId },
        select: { id: true },
      });
      for (const ride of rides) {
        await dataSource.getRepository(Booking).delete({ rideId: ride.id });
        await dataSource.getRepository(Ride).delete({ id: ride.id });
      }
      await dataSource.getRepository(WalletHold).delete({
        walletId: ctx.walletId,
      });
      await dataSource.getRepository(WalletTransaction).delete({
        walletId: ctx.walletId,
      });
      await dataSource.getRepository(Vehicle).delete({ userId: ctx.userId });
      await dataSource.getRepository(UserVerification).delete({
        userId: ctx.userId,
      });
      await dataSource.getRepository(UserProfile).delete({
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

  async function setGender(userId: string, gender: Gender | null) {
    const repo = dataSource.getRepository(UserProfile);
    let profile = await repo.findOne({ where: { userId } });
    if (!profile) {
      profile = repo.create({
        userId,
        firstName: 'Rider',
        lastName: null,
        displayName: null,
        gender,
        dateOfBirth: null,
        profilePhoto: null,
      });
    } else {
      profile.gender = gender;
    }
    await repo.save(profile);
  }

  async function publishRegularDriver(womenOnly: boolean) {
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
      idempotencyKey: uniqueIdempotencyKey('women-driver-fund'),
    });

    const rideResponse = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        rideType: RideType.REGULAR,
        vehicleId: vehicle.id,
        source: 'Noida Sector 62',
        destination: 'Connaught Place',
        departureDate: '2026-09-20',
        departureTime: '09:00',
        totalSeats: 3,
        pricePerSeat: 100,
        womenOnly,
      })
      .expect(201);

    expect(rideResponse.body.womenOnly).toBe(womenOnly);
    return { login, ride: rideResponse.body };
  }

  async function fundedPassenger(gender: Gender | null, credit = 5000n) {
    const { login, wallet, balance } = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await setGender(login.user.id, gender);

    if (credit > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: credit,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('women-passenger-fund'),
      });
    }

    return { login, wallet, balance };
  }

  it('female passenger books womenOnly Regular ride', async () => {
    const { login: driver, ride } = await publishRegularDriver(true);
    const { login: passenger } = await fundedPassenger(Gender.FEMALE);

    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);

    expect(booking.body.status).toBe(BookingStatus.CONFIRMED);
    expect(driver.user.id).toBeTruthy();
  });

  it('male passenger is rejected with WOMEN_ONLY_RIDE and no booking/wallet change', async () => {
    const { ride } = await publishRegularDriver(true);
    const { login: passenger, wallet } = await fundedPassenger(Gender.MALE);

    const balanceBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });

    // Client-injected gender/isFemale fields are rejected by validation whitelist.
    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
        gender: Gender.FEMALE,
        isFemale: true,
      })
      .expect(400);

    const response = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(403);

    expect(response.body).toMatchObject({
      statusCode: 403,
      code: 'WOMEN_ONLY_RIDE',
    });

    const bookingCount = await dataSource.getRepository(Booking).count({
      where: { passengerId: passenger.user.id, rideId: ride.id },
    });
    expect(bookingCount).toBe(0);

    const storedRide = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.id,
    });
    expect(storedRide.availableSeats).toBe(3);

    const balanceAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(balanceAfter.purchasedAvailable).toBe(
      balanceBefore.purchasedAvailable,
    );
  });

  it('unset gender is rejected on womenOnly ride', async () => {
    const { ride } = await publishRegularDriver(true);
    const { login: passenger } = await fundedPassenger(null);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(403);
  });

  it('normal ride still allows male passengers', async () => {
    const { ride } = await publishRegularDriver(false);
    const { login: passenger } = await fundedPassenger(Gender.MALE);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.PAY_LATER,
      })
      .expect(201);
  });

  async function publishAssuredWomenOnlyRide() {
    const { login, wallet } = await createAuthenticatedUser();
    const vehicle = await vehiclesService.create(login.user.id, {
      vehicleType: VehicleType.CAR,
      make: 'Honda',
      model: 'City',
      variant: 'ZX',
      registrationNumber: `UP32${Date.now().toString().slice(-6)}${Math.floor(
        Math.random() * 10,
      )}`,
      registrationYear: 2024,
      color: 'Black',
      seatingCapacity: 5,
    });
    await markVerified(login.user.id, VerificationType.IDENTITY);
    await markVerified(login.user.id, VerificationType.DRIVING_LICENSE);
    await markVerified(login.user.id, VerificationType.VEHICLE);

    await walletService.creditPoints({
      walletId: wallet.id,
      userId: login.user.id,
      amount: 20000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('women-assured-driver'),
    });

    const rideResponse = await request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(login.accessToken))
      .send({
        rideType: RideType.ASSURED,
        ...ASSURED_TEST_ROUTE,
        vehicleId: vehicle.id,
        source: 'Women Assured Source',
        destination: 'Women Assured Dest',
        departureDate: '2026-11-20',
        departureTime: '10:00',
        totalSeats: 2,
        pricePerSeat: 500,
        womenOnly: true,
      })
      .expect(201);

    expect(rideResponse.body.womenOnly).toBe(true);
    return { login, wallet, ride: rideResponse.body as { id: string } };
  }

  it('ASSURED + womenOnly: female rider books and security deposit is held', async () => {
    const { ride } = await publishAssuredWomenOnlyRide();
    const { login: passenger, wallet } = await fundedPassenger(
      Gender.FEMALE,
      2000n,
    );

    const balanceBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });

    const booked = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('women-assured-female'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        farePayment: BookingFarePayment.PAY_LATER,
      })
      .expect(201);

    expect(booked.body).toMatchObject({
      status: BookingStatus.CONFIRMED,
      paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      paymentStatus: BookingPaymentStatus.UNPAID,
      securityDepositStatus: 'HELD',
    });
    expect(booked.body.securityDepositAmount).toBeTruthy();
    expect(BigInt(booked.body.securityDepositAmount)).toBeGreaterThan(0n);

    const row = await dataSource.getRepository(Booking).findOneByOrFail({
      id: booked.body.id,
    });
    expect(row.walletHoldId).toBeTruthy();

    const hold = await dataSource.getRepository(WalletHold).findOneByOrFail({
      id: row.walletHoldId!,
    });
    expect(hold).toMatchObject({
      walletId: wallet.id,
      holdType: WalletHoldType.ASSURED_DEPOSIT,
      status: WalletHoldStatus.ACTIVE,
    });
    expect(BigInt(hold.amount)).toBe(BigInt(booked.body.securityDepositAmount));

    const holdTxCount = await dataSource.getRepository(WalletTransaction).count({
      where: {
        walletId: wallet.id,
        transactionType: WalletTransactionType.ASSURED_DEPOSIT_HOLD,
      },
    });
    expect(holdTxCount).toBe(1);

    const fareDebitCount = await dataSource
      .getRepository(WalletTransaction)
      .count({
        where: {
          walletId: wallet.id,
          transactionType: WalletTransactionType.BOOKING_PAYMENT,
        },
      });
    expect(fareDebitCount).toBe(0);

    const balanceAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(BigInt(balanceAfter.purchasedAvailable)).toBe(
      BigInt(balanceBefore.purchasedAvailable) - BigInt(hold.amount),
    );
    expect(BigInt(balanceAfter.purchasedHeld)).toBe(
      BigInt(balanceBefore.purchasedHeld) + BigInt(hold.amount),
    );
  });

  it('ASSURED + womenOnly: male rider gets 403 with no booking/hold/debit', async () => {
    const { ride } = await publishAssuredWomenOnlyRide();
    const { login: passenger, wallet } = await fundedPassenger(
      Gender.MALE,
      2000n,
    );

    const balanceBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    const holdCountBefore = await dataSource.getRepository(WalletHold).count({
      where: { walletId: wallet.id },
    });
    const txCountBefore = await dataSource
      .getRepository(WalletTransaction)
      .count({ where: { walletId: wallet.id } });

    const response = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('women-assured-male'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        farePayment: BookingFarePayment.PAY_LATER,
      })
      .expect(403);

    expect(response.body).toMatchObject({
      statusCode: 403,
      code: 'WOMEN_ONLY_RIDE',
    });

    expect(
      await dataSource.getRepository(Booking).count({
        where: { passengerId: passenger.user.id, rideId: ride.id },
      }),
    ).toBe(0);

    expect(
      await dataSource.getRepository(WalletHold).count({
        where: { walletId: wallet.id },
      }),
    ).toBe(holdCountBefore);

    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: wallet.id },
      }),
    ).toBe(txCountBefore);

    const balanceAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(balanceAfter.purchasedAvailable).toBe(
      balanceBefore.purchasedAvailable,
    );
    expect(balanceAfter.purchasedHeld).toBe(balanceBefore.purchasedHeld);
  });

  it('ASSURED + womenOnly: null gender gets 403 with no financial movement', async () => {
    const { ride } = await publishAssuredWomenOnlyRide();
    const { login: passenger, wallet } = await fundedPassenger(null, 2000n);

    const balanceBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    const holdCountBefore = await dataSource.getRepository(WalletHold).count({
      where: { walletId: wallet.id },
    });
    const txCountBefore = await dataSource
      .getRepository(WalletTransaction)
      .count({ where: { walletId: wallet.id } });

    const response = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('women-assured-null'))
      .send({
        rideId: ride.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        farePayment: BookingFarePayment.PAY_LATER,
      })
      .expect(403);

    expect(response.body).toMatchObject({
      statusCode: 403,
      code: 'WOMEN_ONLY_RIDE',
    });

    expect(
      await dataSource.getRepository(Booking).count({
        where: { passengerId: passenger.user.id, rideId: ride.id },
      }),
    ).toBe(0);
    expect(
      await dataSource.getRepository(WalletHold).count({
        where: { walletId: wallet.id },
      }),
    ).toBe(holdCountBefore);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: { walletId: wallet.id },
      }),
    ).toBe(txCountBefore);

    const balanceAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });
    expect(balanceAfter.purchasedAvailable).toBe(
      balanceBefore.purchasedAvailable,
    );
    expect(balanceAfter.purchasedHeld).toBe(balanceBefore.purchasedHeld);
  });
});
