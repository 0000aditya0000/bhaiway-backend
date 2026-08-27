import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';

import {
  calculateDriverAssuredDeposit,
  calculateRiderAssuredDeposit,
} from '../assured/assured-deposit.math';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { BookingsModule } from '../bookings/bookings.module';
import { BookingsService } from '../bookings/bookings.service';
import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingFarePayment,
  BookingPaymentMethod,
  BookingPaymentStatus,
} from '../bookings/enums/booking.enums';
import { SettingsModule } from '../settings/settings.module';
import { SettingsService } from '../settings/settings.service';
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
import {
  WalletHold,
  WalletHoldType,
} from '../wallet/entities/wallet-hold.entity';
import { WalletHoldAllocation } from '../wallet/entities/wallet-hold-allocation.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import { Wallet, WalletStatus } from '../wallet/entities/wallet.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { Ride } from './entities/ride.entity';
import { RideStatus, RideType } from './enums/ride.enums';
import { RidesModule } from './rides.module';
import { ASSURED_TEST_ROUTE } from './test/assured-ride-test.helpers';

describe('Assured deposit Phase 2 (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  let settingsService: SettingsService;
  let bookingsService: BookingsService;
  const tracked: TestWalletContext[] = [];
  let originalPercentage: number;

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
    settingsService = moduleRef.get(SettingsService);
    bookingsService = moduleRef.get(BookingsService);
    originalPercentage =
      await settingsService.getAssuredRideDepositPercentage();
  });

  afterEach(async () => {
    await settingsService.setAssuredRideDepositPercentage(originalPercentage);
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
    if (credit > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: credit,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('dep-driver'),
      });
    }
    return { login, wallet, vehicle };
  }

  async function fundedPassenger(credit = 1000n) {
    const { login, wallet } = await createAuthenticatedUser();
    await markVerified(login.user.id, VerificationType.IDENTITY);
    if (credit > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: credit,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('dep-pass'),
      });
    }
    return { login, wallet };
  }

  it('default deposit percentage is 5 and rejects invalid values', async () => {
    expect(await settingsService.getAssuredRideDepositPercentage()).toBe(5);
    await expect(
      settingsService.setAssuredRideDepositPercentage(0),
    ).rejects.toBeDefined();
    await expect(
      settingsService.setAssuredRideDepositPercentage(101),
    ).rejects.toBeDefined();
    await expect(
      settingsService.setAssuredRideDepositPercentage(-1),
    ).rejects.toBeDefined();
  });

  it('driver and rider deposit formulas match product examples', () => {
    expect(calculateDriverAssuredDeposit(4, 500n, 5)).toBe(100n);
    expect(calculateRiderAssuredDeposit(1, 500n, 5)).toBe(25n);
    expect(calculateRiderAssuredDeposit(2, 500n, 5)).toBe(50n);
    expect(calculateDriverAssuredDeposit(4, 500n, 7)).toBe(140n);
  });

  it('publishes Assured ride with driver deposit hold and ledger', async () => {
    const driver = await fundedDriver();

    const response = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        ...ASSURED_TEST_ROUTE,
        vehicleId: driver.vehicle.id,
        source: 'Deposit Source',
        destination: 'Deposit Dest',
        departureDate: '2026-09-01',
        departureTime: '10:00',
        totalSeats: 4,
        pricePerSeat: 500,
      })
      .expect(201);

    expect(response.body.assuredDepositPercentage).toBe(5);
    expect(response.body.assuredDepositAmount).toBe('100');

    const hold = await dataSource.getRepository(WalletHold).findOneByOrFail({
      id: (
        await dataSource.getRepository(Ride).findOneByOrFail({
          id: response.body.id,
        })
      ).driverDepositHoldId!,
    });
    expect(hold.holdType).toBe(WalletHoldType.ASSURED_DEPOSIT);
    expect(hold.amount).toBe('100');
    expect(hold.referenceType).toBe('ASSURED_RIDE_DRIVER_DEPOSIT');
    expect(hold.referenceId).toBe(response.body.id);

    const tx = await dataSource
      .getRepository(WalletTransaction)
      .findOneByOrFail({
        walletId: driver.wallet.id,
        transactionType: WalletTransactionType.ASSURED_DEPOSIT_HOLD,
      });
    expect(tx.direction).toBe(WalletTransactionDirection.DEBIT);
    expect(tx.amount).toBe('100');

    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driver.wallet.id });
    expect(balance.purchasedAvailable).toBe('9900');
    expect(balance.purchasedHeld).toBe('100');

    const allocations = await dataSource
      .getRepository(WalletHoldAllocation)
      .find({ where: { holdId: hold.id } });
    const allocSum = allocations.reduce(
      (sum, row) => sum + BigInt(row.amount),
      0n,
    );
    expect(allocSum).toBe(100n);
  });

  it('insufficient / suspended / locked driver wallet blocks Assured publish', async () => {
    const poor = await fundedDriver(10n);
    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${poor.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        ...ASSURED_TEST_ROUTE,
        vehicleId: poor.vehicle.id,
        source: 'Poor Source',
        destination: 'Poor Dest',
        departureDate: '2026-09-01',
        departureTime: '10:00',
        totalSeats: 4,
        pricePerSeat: 500,
      })
      .expect(422);
    expect(
      await dataSource.getRepository(Ride).count({
        where: { driverId: poor.login.user.id },
      }),
    ).toBe(0);
    expect(
      await dataSource.getRepository(WalletHold).count({
        where: { walletId: poor.wallet.id },
      }),
    ).toBe(0);

    const suspended = await fundedDriver();
    await dataSource.getRepository(Wallet).update(
      { id: suspended.wallet.id },
      { status: WalletStatus.SUSPENDED },
    );
    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${suspended.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        ...ASSURED_TEST_ROUTE,
        vehicleId: suspended.vehicle.id,
        source: 'Sus Source',
        destination: 'Sus Dest',
        departureDate: '2026-09-01',
        departureTime: '11:00',
        totalSeats: 2,
        pricePerSeat: 100,
      })
      .expect(403);

    const locked = await fundedDriver();
    await dataSource
      .getRepository(Wallet)
      .update({ id: locked.wallet.id }, { status: WalletStatus.LOCKED });
    await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${locked.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        ...ASSURED_TEST_ROUTE,
        vehicleId: locked.vehicle.id,
        source: 'Lock Source',
        destination: 'Lock Dest',
        departureDate: '2026-09-01',
        departureTime: '12:00',
        totalSeats: 2,
        pricePerSeat: 100,
      })
      .expect(403);
  });

  it('blocks material Assured price/seat updates while deposit active', async () => {
    const driver = await fundedDriver();
    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        ...ASSURED_TEST_ROUTE,
        vehicleId: driver.vehicle.id,
        source: 'Update Source',
        destination: 'Update Dest',
        departureDate: '2026-09-02',
        departureTime: '09:00',
        totalSeats: 4,
        pricePerSeat: 500,
      })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/rides/${ride.body.id}`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ pricePerSeat: 600 })
      .expect(409);

    await request(app.getHttpServer())
      .patch(`/rides/${ride.body.id}`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ totalSeats: 3 })
      .expect(409);

    await request(app.getHttpServer())
      .patch(`/rides/${ride.body.id}`)
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ notes: 'ok change' })
      .expect(200);
  });

  it('Assured booking creates rider deposit; snapshot survives admin change', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(500n);

    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        ...ASSURED_TEST_ROUTE,
        vehicleId: driver.vehicle.id,
        source: 'Book Source',
        destination: 'Book Dest',
        departureDate: '2026-09-03',
        departureTime: '08:00',
        totalSeats: 4,
        pricePerSeat: 500,
      })
      .expect(201);

    const key = uniqueIdempotencyKey('rider-dep');
    const booking = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', key)
      .send({
        rideId: ride.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        depositAmount: '1',
        assuredDepositPercentage: 99,
      })
      .expect(400);

    const ok = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', key)
      .send({
        rideId: ride.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      })
      .expect(201);

    expect(ok.body).toMatchObject({
      paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      paymentStatus: BookingPaymentStatus.UNPAID,
      farePayment: BookingFarePayment.PAY_LATER,
      farePaymentStatus: BookingPaymentStatus.UNPAID,
      securityDepositAmount: '25',
      securityDepositPercentage: 5,
      securityDepositStatus: 'HELD',
      totalAmount: '500',
      fareAmount: '500',
    });

    await settingsService.setAssuredRideDepositPercentage(7);
    const row = await dataSource.getRepository(Booking).findOneByOrFail({
      id: ok.body.id,
    });
    expect(row.assuredDepositPercentage).toBe(5);
    expect(row.assuredDepositAmount).toBe('25');

    const retry = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', key)
      .send({
        rideId: ride.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      })
      .expect(201);
    expect(retry.body.id).toBe(ok.body.id);

    expect(
      await dataSource.getRepository(WalletHold).count({
        where: { walletId: passenger.wallet.id },
      }),
    ).toBe(1);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          walletId: passenger.wallet.id,
          transactionType: WalletTransactionType.ASSURED_DEPOSIT_HOLD,
        },
      }),
    ).toBe(1);
    expect(
      await dataSource.getRepository(WalletTransaction).count({
        where: {
          walletId: passenger.wallet.id,
          transactionType: WalletTransactionType.BOOKING_PAYMENT,
        },
      }),
    ).toBe(0);

    void booking;
  });

  it('booking failure rolls back rider hold and seats', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger(500n);
    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        ...ASSURED_TEST_ROUTE,
        vehicleId: driver.vehicle.id,
        source: 'Rollback Source',
        destination: 'Rollback Dest',
        departureDate: '2026-09-04',
        departureTime: '07:00',
        totalSeats: 3,
        pricePerSeat: 500,
      })
      .expect(201);

    const seatsBefore = (
      await dataSource.getRepository(Ride).findOneByOrFail({ id: ride.body.id })
    ).availableSeats;
    const balanceBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: passenger.wallet.id });

    const originalSave = Repository.prototype.save;
    const spy = jest
      .spyOn(Repository.prototype, 'save')
      .mockImplementation(async function (
        this: Repository<unknown>,
        entity: unknown,
        ...rest: unknown[]
      ) {
        const maybeBooking = entity as {
          passengerId?: string;
          paymentMethod?: string;
          assuredDepositAmount?: string;
        };
        if (
          maybeBooking?.passengerId &&
          maybeBooking.paymentMethod === BookingPaymentMethod.ASSURED_DEPOSIT &&
          maybeBooking.assuredDepositAmount
        ) {
          throw new Error('forced assured booking failure');
        }
        return originalSave.apply(this, [entity, ...rest] as never);
      });

    try {
      await expect(
        bookingsService.create(
          passenger.login.user.id,
          {
            rideId: ride.body.id,
            seats: 1,
            paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
          },
          { idempotencyKey: uniqueIdempotencyKey('rollback') },
        ),
      ).rejects.toThrow('forced assured booking failure');
    } finally {
      spy.mockRestore();
    }

    expect(
      await dataSource.getRepository(Booking).count({
        where: { rideId: ride.body.id },
      }),
    ).toBe(0);
    expect(
      (
        await dataSource
          .getRepository(Ride)
          .findOneByOrFail({ id: ride.body.id })
      ).availableSeats,
    ).toBe(seatsBefore);
    const balanceAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: passenger.wallet.id });
    expect(balanceAfter.purchasedAvailable).toBe(
      balanceBefore.purchasedAvailable,
    );
    expect(balanceAfter.purchasedHeld).toBe(balanceBefore.purchasedHeld);
  });

  it('concurrent Assured bookings cannot overbook', async () => {
    const driver = await fundedDriver();
    const a = await fundedPassenger(500n);
    const b = await fundedPassenger(500n);
    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        ...ASSURED_TEST_ROUTE,
        vehicleId: driver.vehicle.id,
        source: 'Conc Source',
        destination: 'Conc Dest',
        departureDate: '2026-09-05',
        departureTime: '06:00',
        totalSeats: 2,
        pricePerSeat: 500,
      })
      .expect(201);

    const results = await Promise.allSettled([
      bookingsService.create(
        a.login.user.id,
        {
          rideId: ride.body.id,
          seats: 2,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        },
        { idempotencyKey: uniqueIdempotencyKey('conc-a') },
      ),
      bookingsService.create(
        b.login.user.id,
        {
          rideId: ride.body.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        },
        { idempotencyKey: uniqueIdempotencyKey('conc-b') },
      ),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

    const rideRow = await dataSource.getRepository(Ride).findOneByOrFail({
      id: ride.body.id,
    });
    expect(rideRow.availableSeats).toBe(0);
  });

  describe('Assured farePayment (deposit + fare)', () => {
    async function publishAssuredRide(
      driver: Awaited<ReturnType<typeof fundedDriver>>,
      overrides: Record<string, unknown> = {},
    ) {
      const res = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${driver.login.accessToken}`)
        .send({
          rideType: RideType.ASSURED,
          ...ASSURED_TEST_ROUTE,
          vehicleId: driver.vehicle.id,
          source: 'FarePay Source',
          destination: 'FarePay Dest',
          departureDate: '2026-11-15',
          departureTime: '10:00',
          totalSeats: 2,
          pricePerSeat: 500,
          ...overrides,
        })
        .expect(201);
      return res.body as { id: string; availableSeats: number };
    }

    it('ASSURED_DEPOSIT without farePayment defaults to PAY_LATER', async () => {
      const driver = await fundedDriver();
      const passenger = await fundedPassenger(500n);
      const ride = await publishAssuredRide(driver);

      const booked = await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('fare-default'))
        .send({
          rideId: ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        })
        .expect(201);

      expect(booked.body.farePayment).toBe(BookingFarePayment.PAY_LATER);
      expect(booked.body.paymentStatus).toBe(BookingPaymentStatus.UNPAID);
      expect(booked.body.securityDepositStatus).toBe('HELD');
      expect(
        await dataSource.getRepository(WalletTransaction).count({
          where: {
            walletId: passenger.wallet.id,
            transactionType: WalletTransactionType.BOOKING_PAYMENT,
          },
        }),
      ).toBe(0);
    });

    it('ASSURED_DEPOSIT + PAY_LATER holds deposit and leaves fare UNPAID', async () => {
      const driver = await fundedDriver();
      const passenger = await fundedPassenger(500n);
      const ride = await publishAssuredRide(driver);

      const booked = await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('fare-later'))
        .send({
          rideId: ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
          farePayment: BookingFarePayment.PAY_LATER,
        })
        .expect(201);

      expect(booked.body).toMatchObject({
        farePayment: BookingFarePayment.PAY_LATER,
        paymentStatus: BookingPaymentStatus.UNPAID,
        farePaymentStatus: BookingPaymentStatus.UNPAID,
        securityDepositAmount: '25',
        securityDepositStatus: 'HELD',
        fareAmount: '500',
      });

      const row = await dataSource.getRepository(Booking).findOneByOrFail({
        id: booked.body.id,
      });
      expect(row.farePaymentMethod).toBe(BookingFarePayment.PAY_LATER);
      expect(row.fareWalletTransactionId).toBeNull();
      expect(row.walletHoldId).toBeTruthy();
    });

    it('ASSURED_DEPOSIT + PAY_NOW holds deposit and debits fare', async () => {
      const driver = await fundedDriver();
      const passenger = await fundedPassenger(600n);
      const ride = await publishAssuredRide(driver);

      const booked = await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('fare-now'))
        .send({
          rideId: ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
          farePayment: BookingFarePayment.PAY_NOW,
        })
        .expect(201);

      expect(booked.body).toMatchObject({
        farePayment: BookingFarePayment.PAY_NOW,
        paymentStatus: BookingPaymentStatus.PAID,
        farePaymentStatus: BookingPaymentStatus.PAID,
        securityDepositAmount: '25',
        securityDepositStatus: 'HELD',
        fareAmount: '500',
      });

      expect(
        await dataSource.getRepository(WalletHold).count({
          where: { walletId: passenger.wallet.id },
        }),
      ).toBe(1);
      expect(
        await dataSource.getRepository(WalletTransaction).count({
          where: {
            walletId: passenger.wallet.id,
            transactionType: WalletTransactionType.ASSURED_DEPOSIT_HOLD,
          },
        }),
      ).toBe(1);
      expect(
        await dataSource.getRepository(WalletTransaction).count({
          where: {
            walletId: passenger.wallet.id,
            transactionType: WalletTransactionType.BOOKING_PAYMENT,
          },
        }),
      ).toBe(1);

      const balance = await dataSource
        .getRepository(WalletBalance)
        .findOneByOrFail({ walletId: passenger.wallet.id });
      // 600 - 25 hold - 500 fare = 75 available; 25 held
      expect(balance.purchasedAvailable).toBe('75');
      expect(balance.purchasedHeld).toBe('25');
    });

    it('rejects Assured PAY_NOW / PAY_LATER without deposit semantics', async () => {
      const driver = await fundedDriver();
      const passenger = await fundedPassenger(1000n);
      const ride = await publishAssuredRide(driver);

      await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('no-dep-now'))
        .send({
          rideId: ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_NOW,
        })
        .expect(409);

      await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .send({
          rideId: ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_LATER,
        })
        .expect(409);
    });

    it('rejects farePayment on Regular payment methods', async () => {
      const driver = await fundedDriver();
      const passenger = await fundedPassenger(1000n);
      const regular = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${driver.login.accessToken}`)
        .send({
          rideType: RideType.REGULAR,
          vehicleId: driver.vehicle.id,
          source: 'Reg Source',
          destination: 'Reg Dest',
          departureDate: '2026-11-16',
          departureTime: '11:00',
          totalSeats: 3,
          pricePerSeat: 200,
        })
        .expect(201);

      await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('reg-fare'))
        .send({
          rideId: regular.body.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_NOW,
          farePayment: BookingFarePayment.PAY_NOW,
        })
        .expect(400);
    });

    it('insufficient balance for PAY_LATER deposit rejects without wallet mutation', async () => {
      const driver = await fundedDriver();
      const passenger = await fundedPassenger(10n);
      const ride = await publishAssuredRide(driver);

      await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('insuf-later'))
        .send({
          rideId: ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
          farePayment: BookingFarePayment.PAY_LATER,
        })
        .expect(422);

      expect(
        await dataSource.getRepository(WalletHold).count({
          where: { walletId: passenger.wallet.id },
        }),
      ).toBe(0);
      expect(
        await dataSource.getRepository(Booking).count({
          where: { rideId: ride.id },
        }),
      ).toBe(0);
    });

    it('insufficient balance for PAY_NOW deposit+fare rejects without partial mutation', async () => {
      const driver = await fundedDriver();
      // Enough for deposit (25) but not deposit+fare (525)
      const passenger = await fundedPassenger(100n);
      const ride = await publishAssuredRide(driver);

      await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('insuf-now'))
        .send({
          rideId: ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
          farePayment: BookingFarePayment.PAY_NOW,
        })
        .expect(422);

      expect(
        await dataSource.getRepository(WalletHold).count({
          where: { walletId: passenger.wallet.id },
        }),
      ).toBe(0);
      expect(
        await dataSource.getRepository(WalletTransaction).count({
          where: { walletId: passenger.wallet.id },
        }),
      ).toBe(1); // only the initial credit
      expect(
        await dataSource.getRepository(Booking).count({
          where: { rideId: ride.id },
        }),
      ).toBe(0);
      const rideRow = await dataSource.getRepository(Ride).findOneByOrFail({
        id: ride.id,
      });
      expect(rideRow.availableSeats).toBe(2);
    });

    it('idempotent Assured PAY_NOW retry does not double debit or hold', async () => {
      const driver = await fundedDriver();
      const passenger = await fundedPassenger(1000n);
      const ride = await publishAssuredRide(driver);
      const key = uniqueIdempotencyKey('idem-now');

      const first = await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .set('Idempotency-Key', key)
        .send({
          rideId: ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
          farePayment: BookingFarePayment.PAY_NOW,
        })
        .expect(201);

      const retry = await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .set('Idempotency-Key', key)
        .send({
          rideId: ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
          farePayment: BookingFarePayment.PAY_NOW,
        })
        .expect(201);

      expect(retry.body.id).toBe(first.body.id);
      expect(
        await dataSource.getRepository(Booking).count({
          where: { rideId: ride.id },
        }),
      ).toBe(1);
      expect(
        await dataSource.getRepository(WalletHold).count({
          where: { walletId: passenger.wallet.id },
        }),
      ).toBe(1);
      expect(
        await dataSource.getRepository(WalletTransaction).count({
          where: {
            walletId: passenger.wallet.id,
            transactionType: WalletTransactionType.BOOKING_PAYMENT,
          },
        }),
      ).toBe(1);
    });

    it('same idempotency key with changed farePayment is rejected', async () => {
      const driver = await fundedDriver();
      const passenger = await fundedPassenger(1000n);
      const ride = await publishAssuredRide(driver);
      const key = uniqueIdempotencyKey('idem-change');

      await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .set('Idempotency-Key', key)
        .send({
          rideId: ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
          farePayment: BookingFarePayment.PAY_LATER,
        })
        .expect(201);

      await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .set('Idempotency-Key', key)
        .send({
          rideId: ride.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
          farePayment: BookingFarePayment.PAY_NOW,
        })
        .expect(409);
    });

    it('final seat PAY_NOW still promotes next PENDING Assured ride', async () => {
      const d1 = await fundedDriver();
      const d2 = await fundedDriver();
      const passenger = await fundedPassenger(2000n);

      const active = await publishAssuredRide(d1, {
        totalSeats: 1,
        departureTime: '14:10',
      });
      const pending = await publishAssuredRide(d2, {
        totalSeats: 2,
        departureTime: '14:40',
      });

      const pendingBefore = await dataSource
        .getRepository(Ride)
        .findOneByOrFail({ id: pending.id });
      expect(pendingBefore.status).toBe(RideStatus.ASSURANCE_PENDING);

      await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${passenger.login.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('full-now'))
        .send({
          rideId: active.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
          farePayment: BookingFarePayment.PAY_NOW,
        })
        .expect(201);

      const [activeAfter, pendingAfter] = await Promise.all([
        dataSource.getRepository(Ride).findOneByOrFail({ id: active.id }),
        dataSource.getRepository(Ride).findOneByOrFail({ id: pending.id }),
      ]);
      expect(activeAfter.availableSeats).toBe(0);
      expect(pendingAfter.status).toBe(RideStatus.ASSURANCE_ACTIVE);
    });

    it('Regular PAY_NOW and PAY_LATER remain unchanged', async () => {
      const driver = await fundedDriver();
      const p1 = await fundedPassenger(1000n);
      const p2 = await fundedPassenger(1000n);
      const regular = await request(app.getHttpServer())
        .post('/rides')
        .set('Authorization', `Bearer ${driver.login.accessToken}`)
        .send({
          rideType: RideType.REGULAR,
          vehicleId: driver.vehicle.id,
          source: 'Compat Source',
          destination: 'Compat Dest',
          departureDate: '2026-11-17',
          departureTime: '12:00',
          totalSeats: 3,
          pricePerSeat: 200,
        })
        .expect(201);

      const later = await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${p1.login.accessToken}`)
        .send({
          rideId: regular.body.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_LATER,
        })
        .expect(201);
      expect(later.body.paymentStatus).toBe(BookingPaymentStatus.UNPAID);
      expect(later.body.farePayment).toBeNull();

      const now = await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', `Bearer ${p2.login.accessToken}`)
        .set('Idempotency-Key', uniqueIdempotencyKey('reg-now-ok'))
        .send({
          rideId: regular.body.id,
          seats: 1,
          paymentMethod: BookingPaymentMethod.PAY_NOW,
        })
        .expect(201);
      expect(now.body.paymentStatus).toBe(BookingPaymentStatus.PAID);
      expect(now.body.farePayment).toBeNull();
    });
  });
});
