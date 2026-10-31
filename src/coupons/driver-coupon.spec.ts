import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AdminModule } from '../admin/admin.module';
import { ADMIN_PERMISSION_COUPONS_MANAGE } from '../admin/admin.constants';
import { AdminUser } from '../admin/entities/admin-user.entity';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { BookingsModule } from '../bookings/bookings.module';
import { Booking } from '../bookings/entities/booking.entity';
import { BookingPaymentMethod } from '../bookings/enums/booking.enums';
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
import { WalletHold } from '../wallet/entities/wallet-hold.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
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
import { RideType } from '../rides/enums/ride.enums';
import { RidesModule } from '../rides/rides.module';
import {
  withAssuredPublishHeaders,
  withAssuredTestRoute,
} from '../rides/test/assured-ride-test.helpers';
import { CouponsModule } from './coupons.module';
import { CouponsService } from './coupons.service';
import { CouponAssignment } from './entities/coupon-assignment.entity';
import { CouponRedemption } from './entities/coupon-redemption.entity';
import { Coupon } from './entities/coupon.entity';
import {
  CouponApplicableTo,
  CouponAudience,
  CouponBenefitType,
  CouponChargeScope,
  CouponRedemptionStatus,
  CouponRideTypeScope,
} from './enums/coupon.enums';

describe('Driver Assured deposit coupons (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let verificationService: VerificationService;
  let vehiclesService: VehiclesService;
  let walletService: WalletService;
  let couponsService: CouponsService;
  const tracked: TestWalletContext[] = [];
  const couponIds: string[] = [];

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
        AdminModule,
        WalletModule,
        SettingsModule,
        VerificationModule,
        VehiclesModule,
        CouponsModule,
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
    couponsService = moduleRef.get(CouponsService);

    await dataSource.query(`
      ALTER TABLE "rides"
      ADD COLUMN IF NOT EXISTS "coupon_redemption_id" uuid
    `);
    await dataSource.query(`
      ALTER TABLE "rides"
      ADD COLUMN IF NOT EXISTS "original_assured_deposit_amount" bigint
    `);
    await dataSource.query(`
      ALTER TABLE "rides"
      ADD COLUMN IF NOT EXISTS "coupon_discount_amount" bigint
    `);
  });

  afterEach(async () => {
    if (couponIds.length > 0) {
      const ids = [...couponIds];
      couponIds.length = 0;
      await dataSource
        .getRepository(CouponRedemption)
        .createQueryBuilder()
        .delete()
        .where('coupon_id IN (:...ids)', { ids })
        .execute();
      await dataSource
        .getRepository(CouponAssignment)
        .createQueryBuilder()
        .delete()
        .where('coupon_id IN (:...ids)', { ids })
        .execute();
      await dataSource
        .getRepository(Coupon)
        .createQueryBuilder()
        .delete()
        .where('id IN (:...ids)', { ids })
        .execute();
    }
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
          await dataSource.getRepository(CouponRedemption).delete({
            rideId: ride.id,
          });
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
    await app?.close();
  });

  function futureWindow() {
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    return { startsAt, expiresAt };
  }

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

  async function ensureAdmin(userId: string): Promise<void> {
    const repo = dataSource.getRepository(AdminUser);
    let admin = await repo.findOne({ where: { userId } });
    if (!admin) {
      admin = repo.create({
        userId,
        username: `drv_coupon_${userId.slice(0, 8)}`,
        passwordHash: 'x',
        permissions: [ADMIN_PERMISSION_COUPONS_MANAGE],
        isActive: true,
      });
    } else {
      admin.permissions = Array.from(
        new Set([...(admin.permissions ?? []), ADMIN_PERMISSION_COUPONS_MANAGE]),
      );
      admin.isActive = true;
    }
    await repo.save(admin);
  }

  async function fundedDriver(credit = 10000n) {
    const { login, wallet } = await createAuthenticatedUser();
    const vehicle = await vehiclesService.create(login.user.id, {
      vehicleType: VehicleType.CAR,
      make: 'Honda',
      model: 'City',
      variant: 'ZX',
      registrationNumber: `UP16${Date.now().toString().slice(-6)}${Math.floor(
        Math.random() * 10,
      )}`,
      registrationYear: 2024,
      color: 'Black',
      seatingCapacity: 5,
    });
    for (const type of [
      VerificationType.IDENTITY,
      VerificationType.DRIVING_LICENSE,
      VerificationType.VEHICLE,
    ]) {
      await markVerificationVerified(
        verificationService,
        dataSource,
        login.user.id,
        type,
      );
    }
    if (credit > 0n) {
      await walletService.creditPoints({
        walletId: wallet.id,
        userId: login.user.id,
        amount: credit,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('drv-coupon'),
      });
    }
    return { login, wallet, vehicle };
  }

  async function createDriverCoupon(
    adminUserId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const code = `DRV${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`.toUpperCase();
    const created = await couponsService.createAdmin(adminUserId, {
      code,
      title: 'Driver deposit coupon',
      benefitType: CouponBenefitType.FIXED_DISCOUNT,
      benefitValue: '10',
      rideTypeScope: CouponRideTypeScope.ASSURED,
      chargeScope: CouponChargeScope.DRIVER_ASSURED_DEPOSIT,
      audience: CouponAudience.PUBLIC,
      applicableTo: CouponApplicableTo.DRIVERS_ONLY,
      ...futureWindow(),
      ...overrides,
    });
    couponIds.push(created.id as string);
    return { created, code: created.code as string };
  }

  async function publishAssured(
    token: string,
    vehicleId: string,
    overrides: Record<string, unknown> = {},
    expectedStatus = 201,
    idempotencyKey?: string,
  ) {
    return request(app.getHttpServer())
      .post('/rides')
      .set(withAssuredPublishHeaders(token, idempotencyKey))
      .send(
        withAssuredTestRoute({
          rideType: RideType.ASSURED,
          vehicleId,
          source: 'Driver Coupon Source',
          destination: 'Driver Coupon Dest',
          departureDate: '2027-11-01',
          departureTime: '10:00',
          totalSeats: 4,
          pricePerSeat: 500,
          ...overrides,
        }),
      )
      .expect(expectedStatus);
  }

  it('previews fixed, percentage, max-cap and never-negative driver deposit discounts', async () => {
    const driver = await fundedDriver();
    await ensureAdmin(driver.login.user.id);

    const fixed = await createDriverCoupon(driver.login.user.id, {
      benefitValue: '10',
    });
    const pct = await createDriverCoupon(driver.login.user.id, {
      benefitType: CouponBenefitType.PERCENTAGE_DISCOUNT,
      benefitValue: '20',
      maxDiscountAmount: '15',
    });
    const oversize = await createDriverCoupon(driver.login.user.id, {
      benefitValue: '999',
    });
    const min = await createDriverCoupon(driver.login.user.id, {
      minEligibleAmount: '200',
    });

    const token = driver.login.accessToken;
    const base = {
      vehicleId: driver.vehicle.id,
      totalSeats: 4,
      pricePerSeat: 500,
    };

    const fixedPreview = await request(app.getHttpServer())
      .post('/coupons/driver/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: fixed.code, ...base })
      .expect(201);
    expect(fixedPreview.body.originalAmount).toBe('100');
    expect(fixedPreview.body.discountAmount).toBe('10');
    expect(fixedPreview.body.finalAmount).toBe('90');
    expect(fixedPreview.body.depositPercentage).toBe(5);

    const pctPreview = await request(app.getHttpServer())
      .post('/coupons/driver/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: pct.code, ...base })
      .expect(201);
    expect(pctPreview.body.discountAmount).toBe('15');
    expect(pctPreview.body.finalAmount).toBe('85');

    const oversizePreview = await request(app.getHttpServer())
      .post('/coupons/driver/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: oversize.code, ...base })
      .expect(201);
    expect(oversizePreview.body.discountAmount).toBe('100');
    expect(oversizePreview.body.finalAmount).toBe('0');

    const minRes = await request(app.getHttpServer())
      .post('/coupons/driver/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: min.code, ...base })
      .expect(422);
    expect(minRes.body.code).toBe('COUPON_MIN_AMOUNT_NOT_MET');
  });

  it('accepts ALL audience driver-deposit coupons and does not consume on preview', async () => {
    const driver = await fundedDriver();
    await ensureAdmin(driver.login.user.id);
    const { code, created } = await createDriverCoupon(driver.login.user.id, {
      applicableTo: CouponApplicableTo.ALL,
    });

    const preview = await request(app.getHttpServer())
      .post('/coupons/driver/preview')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        code,
        vehicleId: driver.vehicle.id,
        totalSeats: 4,
        pricePerSeat: 500,
      })
      .expect(201);
    expect(preview.body.valid).toBe(true);
    expect(preview.body.applicableTo).toBe(CouponApplicableTo.ALL);
    expect(preview.body.finalAmount).toBe('90');

    const row = await dataSource.getRepository(Coupon).findOneByOrFail({
      id: created.id as string,
    });
    expect(row.reservedCount).toBe(0);
    expect(row.redeemedCount).toBe(0);
    expect(
      await dataSource.getRepository(CouponRedemption).count({
        where: { couponId: created.id as string },
      }),
    ).toBe(0);
  });

  it('rejects invalid and rider-only codes on driver validate', async () => {
    const driver = await fundedDriver();
    await ensureAdmin(driver.login.user.id);
    const riders = await createDriverCoupon(driver.login.user.id, {
      applicableTo: CouponApplicableTo.RIDERS_ONLY,
    });
    const body = {
      vehicleId: driver.vehicle.id,
      totalSeats: 4,
      pricePerSeat: 500,
    };

    const missing = await request(app.getHttpServer())
      .post('/coupons/driver/validate')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ code: 'NOPE1234', ...body })
      .expect(404);
    expect(missing.body.code).toBe('COUPON_NOT_FOUND');

    const riderOnly = await request(app.getHttpServer())
      .post('/coupons/driver/validate')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({ code: riders.code, ...body })
      .expect(422);
    expect(riderOnly.body.code).toBe('COUPON_RIDERS_ONLY');
  });

  it('redeems a driver coupon atomically with the Assured deposit hold', async () => {
    const driver = await fundedDriver();
    await ensureAdmin(driver.login.user.id);
    const { code } = await createDriverCoupon(driver.login.user.id);

    const published = await publishAssured(
      driver.login.accessToken,
      driver.vehicle.id,
      { couponCode: code },
    );
    expect(published.body.assuredDepositAmount).toBe('90');
    expect(published.body.originalAssuredDepositAmount).toBe('100');
    expect(published.body.couponDiscountAmount).toBe('10');
    expect(published.body.couponRedemptionId).toBeTruthy();

    const ride = await dataSource.getRepository(Ride).findOneByOrFail({
      id: published.body.id,
    });
    expect(ride.assuredDepositAmount).toBe('90');
    expect(ride.couponRedemptionId).toBe(published.body.couponRedemptionId);

    const redemption = await dataSource
      .getRepository(CouponRedemption)
      .findOneByOrFail({ id: ride.couponRedemptionId! });
    expect(redemption.status).toBe(CouponRedemptionStatus.REDEEMED);
    expect(redemption.userId).toBe(driver.login.user.id);
    expect(redemption.bookingId).toBeNull();
    expect(redemption.originalAmount).toBe('100');
    expect(redemption.discountAmount).toBe('10');
    expect(redemption.finalAmount).toBe('90');
    expect(redemption.chargeScope).toBe(
      CouponChargeScope.DRIVER_ASSURED_DEPOSIT,
    );

    const hold = await dataSource.getRepository(WalletHold).findOneByOrFail({
      id: ride.driverDepositHoldId!,
    });
    expect(hold.amount).toBe('90');
  });

  it('does not consume a coupon when the deposit hold fails', async () => {
    const driver = await fundedDriver(50n);
    await ensureAdmin(driver.login.user.id);
    const { code, created } = await createDriverCoupon(driver.login.user.id);

    await publishAssured(
      driver.login.accessToken,
      driver.vehicle.id,
      { couponCode: code },
      422,
    );

    expect(
      await dataSource.getRepository(Ride).count({
        where: { driverId: driver.login.user.id },
      }),
    ).toBe(0);
    expect(
      await dataSource.getRepository(CouponRedemption).count({
        where: { couponId: created.id as string },
      }),
    ).toBe(0);
    const coupon = await dataSource.getRepository(Coupon).findOneByOrFail({
      id: created.id as string,
    });
    expect(coupon.reservedCount).toBe(0);
    expect(coupon.redeemedCount).toBe(0);
  });

  it('replays Assured publish idempotently without a second redemption', async () => {
    const driver = await fundedDriver();
    await ensureAdmin(driver.login.user.id);
    const { code } = await createDriverCoupon(driver.login.user.id);
    const key = uniqueIdempotencyKey('drv-coupon-idem');

    const first = await publishAssured(
      driver.login.accessToken,
      driver.vehicle.id,
      { couponCode: code },
      201,
      key,
    );
    const second = await publishAssured(
      driver.login.accessToken,
      driver.vehicle.id,
      { couponCode: code },
      201,
      key,
    );
    expect(second.body.id).toBe(first.body.id);

    const count = await dataSource.getRepository(CouponRedemption).count({
      where: { userId: driver.login.user.id },
    });
    expect(count).toBe(1);
  });

  it('rejects expired and inactive driver coupons at publish', async () => {
    const driver = await fundedDriver();
    await ensureAdmin(driver.login.user.id);
    const expired = await createDriverCoupon(driver.login.user.id, {
      startsAt: new Date(Date.now() - 7 * 24 * 3600_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const inactive = await createDriverCoupon(driver.login.user.id, {
      isActive: false,
    });

    const expiredRes = await publishAssured(
      driver.login.accessToken,
      driver.vehicle.id,
      { couponCode: expired.code },
      422,
    );
    expect(expiredRes.body.code).toBe('COUPON_EXPIRED');

    const inactiveRes = await publishAssured(
      driver.login.accessToken,
      driver.vehicle.id,
      { couponCode: inactive.code, departureTime: '11:00' },
      422,
    );
    expect(inactiveRes.body.code).toBe('COUPON_INACTIVE');
  });

  it('rejects a driver-only coupon through passenger booking', async () => {
    const driver = await fundedDriver();
    const passenger = await createAuthenticatedUser();
    await markVerificationVerified(
      verificationService,
      dataSource,
      passenger.login.user.id,
      VerificationType.IDENTITY,
    );
    await walletService.creditPoints({
      walletId: passenger.wallet.id,
      userId: passenger.login.user.id,
      amount: 1000n,
      sourceType: WalletPointSource.PURCHASED,
      idempotencyKey: uniqueIdempotencyKey('drv-coupon-pass'),
    });
    await ensureAdmin(driver.login.user.id);
    const { code } = await createDriverCoupon(driver.login.user.id);

    const ride = await publishAssured(
      driver.login.accessToken,
      driver.vehicle.id,
    );

    const booked = await request(app.getHttpServer())
      .post('/bookings')
      .set('Authorization', `Bearer ${passenger.login.accessToken}`)
      .set('Idempotency-Key', uniqueIdempotencyKey('drv-coupon-book'))
      .send({
        rideId: ride.body.id,
        seats: 1,
        paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
        couponCode: code,
      })
      .expect(422);
    expect(booked.body.code).toBe('COUPON_INVALID_TRANSACTION_CONTEXT');
  });

  it('rejects RIDERS_ONLY coupons on Assured driver publish', async () => {
    const driver = await fundedDriver();
    await ensureAdmin(driver.login.user.id);
    const { code } = await createDriverCoupon(driver.login.user.id, {
      applicableTo: CouponApplicableTo.RIDERS_ONLY,
    });

    const res = await publishAssured(
      driver.login.accessToken,
      driver.vehicle.id,
      { couponCode: code },
      422,
    );
    expect(res.body.code).toBe('COUPON_RIDERS_ONLY');
  });

  it('respects global usage limits across concurrent driver publishes', async () => {
    const adminDriver = await fundedDriver();
    await ensureAdmin(adminDriver.login.user.id);
    const { code } = await createDriverCoupon(adminDriver.login.user.id, {
      applicableTo: CouponApplicableTo.ALL,
      totalRedemptionLimit: 1,
      perUserRedemptionLimit: null,
    });
    const other = await fundedDriver();

    const payload = (vehicleId: string, departureTime: string) =>
      withAssuredTestRoute({
        rideType: RideType.ASSURED,
        vehicleId,
        source: 'Driver Coupon Source',
        destination: 'Driver Coupon Dest',
        departureDate: '2027-11-01',
        departureTime,
        totalSeats: 4,
        pricePerSeat: 500,
        couponCode: code,
      });

    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .post('/rides')
        .set(withAssuredPublishHeaders(adminDriver.login.accessToken))
        .send(payload(adminDriver.vehicle.id, '10:15')),
      request(app.getHttpServer())
        .post('/rides')
        .set(withAssuredPublishHeaders(other.login.accessToken))
        .send(payload(other.vehicle.id, '10:30')),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const redeemed = await dataSource.getRepository(CouponRedemption).count({
      where: { codeSnapshot: code, status: CouponRedemptionStatus.REDEEMED },
    });
    expect(redeemed).toBe(1);
  });

  it('rejects client-supplied transactionContext on driver preview', async () => {
    const driver = await fundedDriver();
    await ensureAdmin(driver.login.user.id);
    const { code } = await createDriverCoupon(driver.login.user.id);
    await request(app.getHttpServer())
      .post('/coupons/driver/preview')
      .set('Authorization', `Bearer ${driver.login.accessToken}`)
      .send({
        code,
        vehicleId: driver.vehicle.id,
        totalSeats: 4,
        pricePerSeat: 500,
        transactionContext: 'RIDER_BOOKING',
        originalAmount: '1',
      })
      .expect(400);
  });
});
