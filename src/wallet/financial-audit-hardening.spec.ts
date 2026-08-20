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
import { BookingPaymentMethod } from '../bookings/enums/booking.enums';
import {
  UserCoupon,
  UserCouponStatus,
  UserCouponType,
} from '../coupons/entities/user-coupon.entity';
import { calculateAssuredHalfTime } from '../assured/assured-timing';
import { SettingsModule } from '../settings/settings.module';
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
  WalletHoldStatus,
  WalletHoldType,
} from '../wallet/entities/wallet-hold.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import {
  PLATFORM_PHONE,
  PLATFORM_SEED_AMOUNT,
  PLATFORM_SEED_IDEMPOTENCY_KEY,
  PLATFORM_USER_ID,
  PLATFORM_WALLET_ID,
} from '../wallet/platform-wallet.constants';
import { PlatformWalletForbiddenError } from '../wallet/errors/wallet.errors';
import { WalletOperationConflictError } from '../wallet/errors/wallet.errors';
import {
  assertSafeTestDatabaseUrl,
  assertWalletBalanceMatchesLots,
  cleanupTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';

describe('Financial audit hardening', () => {
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
      if (!ctx) continue;
      await dataSource.getRepository(UserCoupon).delete({ userId: ctx.userId });
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
        idempotencyKey: uniqueIdempotencyKey('audit-driver'),
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
        idempotencyKey: uniqueIdempotencyKey('audit-pass'),
      });
    }
    return { login, wallet };
  }

  it('H1: platform seed has an opening PLATFORM_SEED ledger row', async () => {
    const tx = await dataSource.getRepository(WalletTransaction).findOne({
      where: { idempotencyKey: PLATFORM_SEED_IDEMPOTENCY_KEY },
    });
    expect(tx).toBeTruthy();
    expect(tx!.walletId).toBe(PLATFORM_WALLET_ID);
    expect(tx!.userId).toBe(PLATFORM_USER_ID);
    expect(tx!.transactionType).toBe(WalletTransactionType.PLATFORM_SEED);
    expect(tx!.amount).toBe(PLATFORM_SEED_AMOUNT);
    expect(tx!.referenceType).toBe('PLATFORM_SEED');
  });

  it('H2: platform wallet balance reconciles with lots', async () => {
    await assertWalletBalanceMatchesLots(dataSource, PLATFORM_WALLET_ID);
  });

  it('H3: Assured half-time is stable across process TZ changes', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      const a = calculateAssuredHalfTime(
        createdAt,
        '2026-01-03',
        '00:00:00',
      ).getTime();
      process.env.TZ = 'Asia/Tokyo';
      const b = calculateAssuredHalfTime(
        createdAt,
        '2026-01-03',
        '00:00:00',
      ).getTime();
      expect(a).toBe(b);
    } finally {
      if (previous === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previous;
      }
    }
  });

  it('H4: platform phone/user cannot authenticate', async () => {
    await expect(
      authService.loginOrRegisterWithVerifiedIdentity({
        phone: PLATFORM_PHONE,
        verified: true,
      }),
    ).rejects.toBeDefined();

    await expect(
      authService.signAccessToken(PLATFORM_USER_ID),
    ).rejects.toBeDefined();
  });

  it('H4: normal wallet ops cannot touch platform wallet; internal ops still work', async () => {
    await expect(
      walletService.creditPoints({
        walletId: PLATFORM_WALLET_ID,
        userId: PLATFORM_USER_ID,
        amount: 1n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('plat-forbid'),
      }),
    ).rejects.toBeInstanceOf(PlatformWalletForbiddenError);

    await expect(
      walletService.debitPoints({
        walletId: PLATFORM_WALLET_ID,
        userId: PLATFORM_USER_ID,
        amount: 1n,
        idempotencyKey: uniqueIdempotencyKey('plat-forbid-debit'),
      }),
    ).rejects.toBeInstanceOf(PlatformWalletForbiddenError);

    const before = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: PLATFORM_WALLET_ID });

    await walletService.creditPoints({
      walletId: PLATFORM_WALLET_ID,
      userId: PLATFORM_USER_ID,
      amount: 5n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('plat-allow'),
      transactionType: WalletTransactionType.ASSURED_PLATFORM_FORFEITURE,
      allowPlatformOperations: true,
    });

    const after = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: PLATFORM_WALLET_ID });
    expect(BigInt(after.purchasedAvailable)).toBe(
      BigInt(before.purchasedAvailable) + 5n,
    );
    await assertWalletBalanceMatchesLots(dataSource, PLATFORM_WALLET_ID);
  });

  it('M1: Assured deposit hold DEBIT does not change total wallet value', async () => {
    const driver = await fundedDriver();
    const before = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: driver.wallet.id });
    const totalBefore =
      BigInt(before.purchasedAvailable) +
      BigInt(before.purchasedHeld) +
      BigInt(before.promotionalAvailable) +
      BigInt(before.promotionalHeld) +
      BigInt(before.driverEarnedAvailable) +
      BigInt(before.driverEarnedHeld);

    const result = await walletService.createHold({
      walletId: driver.wallet.id,
      amount: 50n,
      holdType: WalletHoldType.ASSURED_DEPOSIT,
      referenceType: 'TEST_HOLD_REF',
      referenceId: uniqueIdempotencyKey('hold-ref'),
      idempotencyKey: uniqueIdempotencyKey('hold-m1'),
    });

    expect(result.transaction.transactionType).toBe(
      WalletTransactionType.ASSURED_DEPOSIT_HOLD,
    );
    expect(result.transaction.balanceBefore).toBe(
      result.transaction.balanceAfter,
    );
    expect(BigInt(result.transaction.balanceBefore)).toBe(totalBefore);
    await assertWalletBalanceMatchesLots(dataSource, driver.wallet.id);
  });

  it('M2: concurrent ACTIVE holds for same reference — exactly one wins', async () => {
    const user = await fundedDriver(500n);
    const referenceId = uniqueIdempotencyKey('dup-ref');
    const results = await Promise.allSettled([
      walletService.createHold({
        walletId: user.wallet.id,
        amount: 10n,
        holdType: WalletHoldType.ASSURED_DEPOSIT,
        referenceType: 'TEST_ACTIVE_HOLD',
        referenceId,
        idempotencyKey: uniqueIdempotencyKey('dup-a'),
      }),
      walletService.createHold({
        walletId: user.wallet.id,
        amount: 10n,
        holdType: WalletHoldType.ASSURED_DEPOSIT,
        referenceType: 'TEST_ACTIVE_HOLD',
        referenceId,
        idempotencyKey: uniqueIdempotencyKey('dup-b'),
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(
      (rejected[0] as PromiseRejectedResult).reason,
    ).toBeInstanceOf(WalletOperationConflictError);

    const active = await dataSource.getRepository(WalletHold).count({
      where: {
        referenceType: 'TEST_ACTIVE_HOLD',
        referenceId,
        status: WalletHoldStatus.ACTIVE,
      },
    });
    expect(active).toBe(1);
  });

  it('M3: USED coupon cannot transition back to UNUSED', async () => {
    const passenger = await fundedPassenger();
    const coupon = await dataSource.getRepository(UserCoupon).save(
      dataSource.getRepository(UserCoupon).create({
        userId: passenger.login.user.id,
        couponType: UserCouponType.NEXT_ASSURED_DEPOSIT_FREE,
        status: UserCouponStatus.USED,
        sourceReferenceType: 'TEST_USED',
        sourceReferenceId: uniqueIdempotencyKey('used-coupon'),
        usedAt: new Date(),
        usedBookingId: null,
        expiresAt: null,
      }),
    );

    await expect(
      dataSource.query(
        `UPDATE user_coupons SET status = 'UNUSED' WHERE id = $1`,
        [coupon.id],
      ),
    ).rejects.toBeDefined();
  });

  it('M5: parallel cancel vs complete yields one terminal ride state', async () => {
    const driver = await fundedDriver();
    const passenger = await fundedPassenger();
    const ride = await request(app.getHttpServer())
      .post('/rides')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        rideType: RideType.ASSURED,
        vehicleId: driver.vehicle.id,
        source: 'Race Source',
        destination: 'Race Dest',
        departureDate: '2099-12-01',
        departureTime: '10:00',
        totalSeats: 4,
        pricePerSeat: 500,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('race-book'))
      .send({
        rideId: ride.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
      })
      .expect(201);

    const [cancelRes, completeRes] = await Promise.all([
      request(app.getHttpServer())
        .post(`/rides/${ride.body.id}/cancel`)
        .set('Authorization', `Bearer ${driver.login.accessToken}`),
      request(app.getHttpServer())
        .post(`/rides/${ride.body.id}/complete`)
        .set('Authorization', `Bearer ${driver.login.accessToken}`),
    ]);

    const statuses = [cancelRes.status, completeRes.status].sort();
    expect(statuses).toEqual([200, 409]);

    const rideRow = await dataSource
      .getRepository(Ride)
      .findOneByOrFail({ id: ride.body.id });
    expect([RideStatus.CANCELLED, RideStatus.COMPLETED]).toContain(
      rideRow.status,
    );

    const hold = await dataSource
      .getRepository(WalletHold)
      .findOneByOrFail({ id: rideRow.driverDepositHoldId! });
    expect([WalletHoldStatus.CONSUMED, WalletHoldStatus.RELEASED]).toContain(
      hold.status,
    );
    if (rideRow.status === RideStatus.CANCELLED) {
      expect(hold.status).toBe(WalletHoldStatus.CONSUMED);
    } else {
      expect(hold.status).toBe(WalletHoldStatus.RELEASED);
    }

    await assertWalletBalanceMatchesLots(dataSource, driver.wallet.id);
    await assertWalletBalanceMatchesLots(dataSource, passenger.wallet.id);
    await assertWalletBalanceMatchesLots(dataSource, PLATFORM_WALLET_ID);
  });

  it('M6: createHold rejects non-ASSURED_DEPOSIT hold types', async () => {
    const user = await fundedDriver(100n);
    await expect(
      walletService.createHold({
        walletId: user.wallet.id,
        amount: 10n,
        holdType: WalletHoldType.BOOKING_PAYMENT,
        referenceType: 'TEST',
        referenceId: uniqueIdempotencyKey('bad-type'),
        idempotencyKey: uniqueIdempotencyKey('bad-type-key'),
      }),
    ).rejects.toBeInstanceOf(WalletOperationConflictError);
  });
});
