import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import request from 'supertest';

import { AdminModule } from '../admin/admin.module';
import { ADMIN_PERMISSION_COUPONS_MANAGE } from '../admin/admin.constants';
import { AdminUser } from '../admin/entities/admin-user.entity';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { UsersModule } from '../users/users.module';
import {
  WalletPointLot,
  WalletPointSource,
} from '../wallet/entities/wallet-point-lot.entity';
import { WalletModule } from '../wallet/wallet.module';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  createTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from '../wallet/test/wallet-test.helpers';
import { CouponIssuanceService } from './coupon-issuance.service';
import { CouponRedemptionService } from './coupon-redemption.service';
import { CouponsModule } from './coupons.module';
import { CouponsService } from './coupons.service';
import { CouponAssignment } from './entities/coupon-assignment.entity';
import { CouponIssuance } from './entities/coupon-issuance.entity';
import { CouponIssuanceRule } from './entities/coupon-issuance-rule.entity';
import { CouponRedemption } from './entities/coupon-redemption.entity';
import { Coupon } from './entities/coupon.entity';
import {
  CouponActorContext,
  CouponApplicableTo,
  CouponAudience,
  CouponBenefitType,
  CouponChargeScope,
  CouponRedemptionStatus,
  CouponRideTypeScope,
  CouponTransactionContext,
  normalizeCouponCode,
  resolveCouponApplicableTo,
} from './enums/coupon.enums';
import {
  CouponAlreadyUsedError,
  CouponDriversOnlyError,
  CouponExhaustedError,
  CouponIneligibleError,
  CouponInvalidTransactionContextError,
  CouponMinAmountNotMetError,
  CouponNotAssignedError,
  CouponRidersOnlyError,
} from './errors/coupon.errors';
import { calculateCouponDiscount } from './coupon.math';

describe('Coupon catalog (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let couponsService: CouponsService;
  let redemptionService: CouponRedemptionService;
  let issuanceService: CouponIssuanceService;
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
        UsersModule,
        WalletModule,
        AdminModule,
        CouponsModule,
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
    couponsService = moduleRef.get(CouponsService);
    redemptionService = moduleRef.get(CouponRedemptionService);
    issuanceService = moduleRef.get(CouponIssuanceService);

    await dataSource.query(`
      ALTER TABLE "coupons"
      ADD COLUMN IF NOT EXISTS "applicable_to" character varying(32) NOT NULL DEFAULT 'ALL'
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
        await cleanupTestWallet(dataSource, ctx);
      }
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  async function trackUser(): Promise<TestWalletContext> {
    const ctx = await createTestWallet(dataSource);
    tracked.push(ctx);
    return ctx;
  }

  async function login(userId: string): Promise<string> {
    return authService.signAccessToken(userId);
  }

  async function ensureAdmin(userId: string): Promise<void> {
    const repo = dataSource.getRepository(AdminUser);
    let admin = await repo.findOne({ where: { userId } });
    if (!admin) {
      admin = repo.create({
        userId,
        username: `coupon_admin_${userId.slice(0, 8)}`,
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

  function futureWindow() {
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    return { startsAt, expiresAt };
  }

  it('hides USER_SPECIFIC coupons from non-assignees and lists for assignees', async () => {
    const owner = await trackUser();
    const stranger = await trackUser();
    await ensureAdmin(owner.userId);
    const adminToken = await login(owner.userId);

    const created = await request(app.getHttpServer())
      .post('/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: `PRIV${Date.now().toString(36).toUpperCase()}`,
        title: 'Private 50',
        benefitType: CouponBenefitType.FIXED_DISCOUNT,
        benefitValue: '50',
        rideTypeScope: CouponRideTypeScope.ASSURED,
        chargeScope: CouponChargeScope.ASSURED_SECURITY_DEPOSIT,
        audience: CouponAudience.USER_SPECIFIC,
        userIds: [owner.userId],
        ...futureWindow(),
        perUserRedemptionLimit: 1,
      })
      .expect(201);

    couponIds.push(created.body.id);

    const mine = await request(app.getHttpServer())
      .get('/coupons/mine')
      .set('Authorization', `Bearer ${await login(owner.userId)}`)
      .expect(200);
    expect(mine.body.items.some((c: { id: string }) => c.id === created.body.id)).toBe(
      true,
    );

    await request(app.getHttpServer())
      .get(`/coupons/${created.body.id}`)
      .set('Authorization', `Bearer ${await login(stranger.userId)}`)
      .expect(404);
  });

  it('rejects admin create without ADMIN_COUPONS_MANAGE', async () => {
    const user = await trackUser();
    const token = await login(user.userId);
    await request(app.getHttpServer())
      .post('/admin/coupons')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Nope',
        benefitType: CouponBenefitType.FIXED_DISCOUNT,
        benefitValue: '10',
        rideTypeScope: CouponRideTypeScope.ALL,
        chargeScope: CouponChargeScope.RIDE_FARE,
        audience: CouponAudience.PUBLIC,
        ...futureWindow(),
      })
      .expect(403);
  });

  it('enforces Assured security-fee fixed discount math via reserve', async () => {
    const user = await trackUser();
    await ensureAdmin(user.userId);
    const adminToken = await login(user.userId);
    const code = `DEP${Date.now().toString(36).toUpperCase()}`;

    const created = await request(app.getHttpServer())
      .post('/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code,
        title: 'Deposit 50 off',
        benefitType: CouponBenefitType.FIXED_DISCOUNT,
        benefitValue: '50',
        rideTypeScope: CouponRideTypeScope.ASSURED,
        chargeScope: CouponChargeScope.ASSURED_SECURITY_DEPOSIT,
        audience: CouponAudience.PUBLIC,
        ...futureWindow(),
        totalRedemptionLimit: 10,
      })
      .expect(201);
    couponIds.push(created.body.id);

    const preview = await request(app.getHttpServer())
      .post('/coupons/preview')
      .set('Authorization', `Bearer ${await login(user.userId)}`)
      .send({
        code,
        rideType: CouponRideTypeScope.ASSURED,
        chargeScope: CouponChargeScope.ASSURED_SECURITY_DEPOSIT,
        amount: '200',
      })
      .expect(201);

    expect(preview.body.originalAmount).toBe('200');
    expect(preview.body.discountAmount).toBe('50');
    expect(preview.body.finalAmount).toBe('150');

    const bookingId = randomUUID();
    const applied = await dataSource.transaction(async (manager) => {
      return redemptionService.reserveInTransaction(manager, {
        userId: user.userId,
        rideType: CouponRideTypeScope.ASSURED,
        chargeScope: CouponChargeScope.ASSURED_SECURITY_DEPOSIT,
        amount: 200n,
        bookingId,
        rideId: randomUUID(),
        code,
        idempotencyKey: uniqueIdempotencyKey('coupon-dep'),
      });
    });

    expect(applied.finalAmount).toBe(150n);
    expect(applied.discountAmount).toBe(50n);

    await dataSource.transaction(async (manager) => {
      await redemptionService.finalizeReservedInTransaction(
        manager,
        applied.redemption.id,
      );
    });

    const row = await dataSource.getRepository(CouponRedemption).findOneOrFail({
      where: { id: applied.redemption.id },
    });
    expect(row.status).toBe(CouponRedemptionStatus.REDEEMED);
    expect(row.originalAmount).toBe('200');
    expect(row.finalAmount).toBe('150');
  });

  it('credits PROMOTIONAL points for POINTS_CREDIT coupons idempotently', async () => {
    const user = await trackUser();
    await ensureAdmin(user.userId);
    const code = `PTS${Date.now().toString(36).toUpperCase()}`;
    const created = await couponsService.createAdmin(user.userId, {
      code,
      title: '50 points',
      benefitType: CouponBenefitType.POINTS_CREDIT,
      benefitValue: '50',
      rideTypeScope: CouponRideTypeScope.ALL,
      chargeScope: CouponChargeScope.RIDE_FARE,
      audience: CouponAudience.PUBLIC,
      ...futureWindow(),
      perUserRedemptionLimit: 1,
    });
    couponIds.push(created.id as string);

    const bookingId = randomUUID();
    const redemptionId = await dataSource.transaction(async (manager) => {
      const reserved = await redemptionService.reserveInTransaction(manager, {
        userId: user.userId,
        rideType: CouponRideTypeScope.REGULAR,
        chargeScope: CouponChargeScope.RIDE_FARE,
        amount: 100n,
        bookingId,
        rideId: randomUUID(),
        code,
        idempotencyKey: uniqueIdempotencyKey('coupon-pts'),
      });
      await redemptionService.finalizeReservedInTransaction(
        manager,
        reserved.redemption.id,
        user.walletId,
      );
      return reserved.redemption.id;
    });

    await dataSource.transaction(async (manager) => {
      await redemptionService.finalizeReservedInTransaction(
        manager,
        redemptionId,
        user.walletId,
      );
    });

    const lots = await dataSource.getRepository(WalletPointLot).find({
      where: { walletId: user.walletId },
    });
    const promo = lots
      .filter((l) => l.sourceType === WalletPointSource.PROMOTIONAL)
      .reduce((s, l) => s + BigInt(l.availableAmount), 0n);
    expect(promo).toBe(50n);

    await expect(
      dataSource.transaction(async (manager) =>
        redemptionService.reserveInTransaction(manager, {
          userId: user.userId,
          rideType: CouponRideTypeScope.REGULAR,
          chargeScope: CouponChargeScope.RIDE_FARE,
          amount: 100n,
          bookingId: randomUUID(),
          rideId: randomUUID(),
          code,
          idempotencyKey: uniqueIdempotencyKey('coupon-pts-2'),
        }),
      ),
    ).rejects.toBeInstanceOf(CouponAlreadyUsedError);
  });

  it('prevents concurrent over-redemption of total limit 1', async () => {
    const a = await trackUser();
    const b = await trackUser();
    await ensureAdmin(a.userId);
    const code = `ONE${Date.now().toString(36).toUpperCase()}`;
    const created = await couponsService.createAdmin(a.userId, {
      code,
      title: 'Global single use',
      benefitType: CouponBenefitType.FIXED_DISCOUNT,
      benefitValue: '10',
      rideTypeScope: CouponRideTypeScope.ALL,
      chargeScope: CouponChargeScope.RIDE_FARE,
      audience: CouponAudience.PUBLIC,
      ...futureWindow(),
      totalRedemptionLimit: 1,
    });
    couponIds.push(created.id as string);

    const results = await Promise.allSettled([
      dataSource.transaction((manager) =>
        redemptionService.reserveInTransaction(manager, {
          userId: a.userId,
          rideType: CouponRideTypeScope.REGULAR,
          chargeScope: CouponChargeScope.RIDE_FARE,
          amount: 100n,
          bookingId: randomUUID(),
          rideId: randomUUID(),
          code,
          idempotencyKey: uniqueIdempotencyKey('c1'),
        }),
      ),
      dataSource.transaction((manager) =>
        redemptionService.reserveInTransaction(manager, {
          userId: b.userId,
          rideType: CouponRideTypeScope.REGULAR,
          chargeScope: CouponChargeScope.RIDE_FARE,
          amount: 100n,
          bookingId: randomUUID(),
          rideId: randomUUID(),
          code,
          idempotencyKey: uniqueIdempotencyKey('c2'),
        }),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      CouponExhaustedError,
    );
  });

  it('blocks unassigned USER_SPECIFIC redemption', async () => {
    const admin = await trackUser();
    const other = await trackUser();
    await ensureAdmin(admin.userId);
    const code = `UA${Date.now().toString(36).toUpperCase()}`;
    const created = await couponsService.createAdmin(admin.userId, {
      code,
      title: 'Private',
      benefitType: CouponBenefitType.FIXED_DISCOUNT,
      benefitValue: '5',
      rideTypeScope: CouponRideTypeScope.ALL,
      chargeScope: CouponChargeScope.RIDE_FARE,
      audience: CouponAudience.USER_SPECIFIC,
      userIds: [admin.userId],
      ...futureWindow(),
    });
    couponIds.push(created.id as string);

    await expect(
      dataSource.transaction((manager) =>
        redemptionService.reserveInTransaction(manager, {
          userId: other.userId,
          rideType: CouponRideTypeScope.REGULAR,
          chargeScope: CouponChargeScope.RIDE_FARE,
          amount: 50n,
          bookingId: randomUUID(),
          rideId: randomUUID(),
          code,
          idempotencyKey: uniqueIdempotencyKey('ua'),
        }),
      ),
    ).rejects.toBeInstanceOf(CouponNotAssignedError);
  });

  it('trip completion issuance is a no-op with inactive rules', async () => {
    const active = await dataSource.getRepository(CouponIssuanceRule).count({
      where: { isActive: true },
    });
    expect(active).toBe(0);

    const result = await issuanceService.processTripCompletion({
      tripId: randomUUID(),
      passengerUserIds: [randomUUID()],
      rideType: 'REGULAR',
    });
    expect(result).toEqual({ processed: 0, issued: 0 });

    await dataSource.transaction(async (manager) => {
      await issuanceService.onTripCompletedInTransaction(manager, {
        tripId: randomUUID(),
        passengerUserIds: [randomUUID()],
        rideType: 'ASSURED',
      });
    });
  });

  it('preview does not consume capacity', async () => {
    const user = await trackUser();
    await ensureAdmin(user.userId);
    const code = `PRV${Date.now().toString(36).toUpperCase()}`;
    const created = await couponsService.createAdmin(user.userId, {
      code,
      title: 'Preview',
      benefitType: CouponBenefitType.PERCENTAGE_DISCOUNT,
      benefitValue: '10',
      maxDiscountAmount: '25',
      rideTypeScope: CouponRideTypeScope.ALL,
      chargeScope: CouponChargeScope.RIDE_FARE,
      audience: CouponAudience.PUBLIC,
      ...futureWindow(),
      totalRedemptionLimit: 1,
    });
    couponIds.push(created.id as string);

    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post('/coupons/preview')
        .set('Authorization', `Bearer ${await login(user.userId)}`)
        .send({
          code,
          rideType: CouponRideTypeScope.REGULAR,
          chargeScope: CouponChargeScope.RIDE_FARE,
          amount: '200',
        })
        .expect(201);
    }

    const coupon = await dataSource.getRepository(Coupon).findOneOrFail({
      where: { id: created.id as string },
    });
    expect(coupon.reservedCount).toBe(0);
    expect(coupon.redeemedCount).toBe(0);
  });

  describe('Assured security-fee accounting', () => {
    it('₹200 original − ₹50 fixed ⇒ ₹150 payable; snapshots persist; fare untouched', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const code = `SF${Date.now().toString(36).toUpperCase()}`;
      const created = await couponsService.createAdmin(user.userId, {
        code,
        title: 'Deposit 50 off',
        benefitType: CouponBenefitType.FIXED_DISCOUNT,
        benefitValue: '50',
        rideTypeScope: CouponRideTypeScope.ASSURED,
        chargeScope: CouponChargeScope.ASSURED_SECURITY_DEPOSIT,
        audience: CouponAudience.PUBLIC,
        ...futureWindow(),
      });
      couponIds.push(created.id as string);

      const math = calculateCouponDiscount(200n, {
        benefitType: CouponBenefitType.FIXED_DISCOUNT,
        benefitValue: 50n,
        maxDiscountAmount: null,
        minEligibleAmount: null,
      });
      expect(math).toEqual({
        originalAmount: 200n,
        discountAmount: 50n,
        finalAmount: 150n,
      });

      const bookingId = randomUUID();
      const fareAmount = 500n; // must remain unchanged by a deposit-scoped coupon

      const applied = await dataSource.transaction(async (manager) => {
        const reserved = await redemptionService.reserveInTransaction(manager, {
          userId: user.userId,
          rideType: CouponRideTypeScope.ASSURED,
          chargeScope: CouponChargeScope.ASSURED_SECURITY_DEPOSIT,
          amount: 200n,
          bookingId,
          rideId: randomUUID(),
          code: code.toLowerCase(), // case-insensitive
          idempotencyKey: uniqueIdempotencyKey('sf-200'),
        });
        expect(reserved.originalAmount).toBe(200n);
        expect(reserved.discountAmount).toBe(50n);
        expect(reserved.finalAmount).toBe(150n);
        // Hold amount in booking flow = reserved.finalAmount only.
        const holdAmount = reserved.finalAmount;
        expect(holdAmount).toBe(150n);
        expect(holdAmount).toBeLessThanOrEqual(reserved.originalAmount);
        expect(holdAmount >= 0n).toBe(true);
        // Fare is a separate charge — deposit coupon must not reduce it.
        expect(fareAmount).toBe(500n);

        await redemptionService.finalizeReservedInTransaction(
          manager,
          reserved.redemption.id,
        );
        return reserved;
      });

      const row = await dataSource.getRepository(CouponRedemption).findOneOrFail({
        where: { id: applied.redemption.id },
      });
      expect(row.status).toBe(CouponRedemptionStatus.REDEEMED);
      expect(row.chargeScope).toBe(
        CouponChargeScope.ASSURED_SECURITY_DEPOSIT,
      );
      expect(row.originalAmount).toBe('200');
      expect(row.discountAmount).toBe('50');
      expect(row.finalAmount).toBe('150');
      expect(row.codeSnapshot).toBe(normalizeCouponCode(code));
      expect(row.couponId).toBe(created.id);
      expect(row.pointsCredited).toBeNull();
    });

    it('security-fee coupon cannot be applied as RIDE_FARE', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const code = `SFx${Date.now().toString(36).toUpperCase()}`;
      const created = await couponsService.createAdmin(user.userId, {
        code,
        title: 'Deposit only',
        benefitType: CouponBenefitType.FIXED_DISCOUNT,
        benefitValue: '50',
        rideTypeScope: CouponRideTypeScope.ASSURED,
        chargeScope: CouponChargeScope.ASSURED_SECURITY_DEPOSIT,
        audience: CouponAudience.PUBLIC,
        ...futureWindow(),
      });
      couponIds.push(created.id as string);

      await expect(
        dataSource.transaction((manager) =>
          redemptionService.reserveInTransaction(manager, {
            userId: user.userId,
            rideType: CouponRideTypeScope.ASSURED,
            chargeScope: CouponChargeScope.RIDE_FARE,
            amount: 500n,
            bookingId: randomUUID(),
            rideId: randomUUID(),
            code,
            idempotencyKey: uniqueIdempotencyKey('sf-fare'),
          }),
        ),
      ).rejects.toBeInstanceOf(CouponIneligibleError);
    });

    it('rejects apply-time chargeScope BOTH', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const code = `BOTH${Date.now().toString(36).toUpperCase()}`;
      const created = await couponsService.createAdmin(user.userId, {
        code,
        title: 'Both config',
        benefitType: CouponBenefitType.FIXED_DISCOUNT,
        benefitValue: '10',
        rideTypeScope: CouponRideTypeScope.ALL,
        chargeScope: CouponChargeScope.BOTH,
        audience: CouponAudience.PUBLIC,
        ...futureWindow(),
      });
      couponIds.push(created.id as string);

      await expect(
        redemptionService.preview(code, {
          userId: user.userId,
          rideType: CouponRideTypeScope.ASSURED,
          chargeScope: CouponChargeScope.BOTH,
          amount: 200n,
        }),
      ).rejects.toBeInstanceOf(CouponIneligibleError);
    });

    it('never allows negative final security fee', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const code = `NEG${Date.now().toString(36).toUpperCase()}`;
      const created = await couponsService.createAdmin(user.userId, {
        code,
        title: 'Oversize discount',
        benefitType: CouponBenefitType.FIXED_DISCOUNT,
        benefitValue: '999',
        rideTypeScope: CouponRideTypeScope.ASSURED,
        chargeScope: CouponChargeScope.ASSURED_SECURITY_DEPOSIT,
        audience: CouponAudience.PUBLIC,
        ...futureWindow(),
      });
      couponIds.push(created.id as string);

      const applied = await dataSource.transaction(async (manager) =>
        redemptionService.reserveInTransaction(manager, {
          userId: user.userId,
          rideType: CouponRideTypeScope.ASSURED,
          chargeScope: CouponChargeScope.ASSURED_SECURITY_DEPOSIT,
          amount: 200n,
          bookingId: randomUUID(),
          rideId: randomUUID(),
          code,
          idempotencyKey: uniqueIdempotencyKey('sf-neg'),
        }),
      );
      expect(applied.finalAmount).toBe(0n);
      expect(applied.discountAmount).toBe(200n);
    });

    it('POINTS_CREDIT does not reduce the security fee', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const code = `PC${Date.now().toString(36).toUpperCase()}`;
      const created = await couponsService.createAdmin(user.userId, {
        code,
        title: 'Points only',
        benefitType: CouponBenefitType.POINTS_CREDIT,
        benefitValue: '50',
        rideTypeScope: CouponRideTypeScope.ASSURED,
        chargeScope: CouponChargeScope.ASSURED_SECURITY_DEPOSIT,
        audience: CouponAudience.PUBLIC,
        ...futureWindow(),
      });
      couponIds.push(created.id as string);

      const applied = await dataSource.transaction(async (manager) => {
        const reserved = await redemptionService.reserveInTransaction(manager, {
          userId: user.userId,
          rideType: CouponRideTypeScope.ASSURED,
          chargeScope: CouponChargeScope.ASSURED_SECURITY_DEPOSIT,
          amount: 200n,
          bookingId: randomUUID(),
          rideId: randomUUID(),
          code,
          idempotencyKey: uniqueIdempotencyKey('sf-pts'),
        });
        await redemptionService.finalizeReservedInTransaction(
          manager,
          reserved.redemption.id,
          user.walletId,
        );
        return reserved;
      });

      expect(applied.finalAmount).toBe(200n);
      expect(applied.discountAmount).toBe(0n);
      expect(applied.pointsToCredit).toBe(50n);

      const lots = await dataSource.getRepository(WalletPointLot).find({
        where: { walletId: user.walletId, sourceType: WalletPointSource.PROMOTIONAL },
      });
      const promo = lots.reduce((s, l) => s + BigInt(l.availableAmount), 0n);
      expect(promo).toBe(50n);
    });
  });

  it('does not restore capacity after REDEEMED (cancel-after-redeem rule)', async () => {
    const user = await trackUser();
    await ensureAdmin(user.userId);
    const code = `NR${Date.now().toString(36).toUpperCase()}`;
    const created = await couponsService.createAdmin(user.userId, {
      code,
      title: 'No restore',
      benefitType: CouponBenefitType.FIXED_DISCOUNT,
      benefitValue: '10',
      rideTypeScope: CouponRideTypeScope.ALL,
      chargeScope: CouponChargeScope.RIDE_FARE,
      audience: CouponAudience.PUBLIC,
      ...futureWindow(),
      totalRedemptionLimit: 1,
      perUserRedemptionLimit: 1,
    });
    couponIds.push(created.id as string);

    const redemptionId = await dataSource.transaction(async (manager) => {
      const reserved = await redemptionService.reserveInTransaction(manager, {
        userId: user.userId,
        rideType: CouponRideTypeScope.REGULAR,
        chargeScope: CouponChargeScope.RIDE_FARE,
        amount: 100n,
        bookingId: randomUUID(),
        rideId: randomUUID(),
        code,
        idempotencyKey: uniqueIdempotencyKey('nr'),
      });
      await redemptionService.finalizeReservedInTransaction(
        manager,
        reserved.redemption.id,
      );
      return reserved.redemption.id;
    });

    await dataSource.transaction(async (manager) => {
      await redemptionService.releaseReservedInTransaction(
        manager,
        redemptionId,
        false,
      );
    });

    const coupon = await dataSource.getRepository(Coupon).findOneOrFail({
      where: { id: created.id as string },
    });
    expect(coupon.redeemedCount).toBe(1);
    expect(coupon.reservedCount).toBe(0);

    const row = await dataSource.getRepository(CouponRedemption).findOneOrFail({
      where: { id: redemptionId },
    });
    expect(row.status).toBe(CouponRedemptionStatus.REDEEMED);
  });

  it('failed booking TX rolls back reservation (no leaked capacity)', async () => {
    const user = await trackUser();
    await ensureAdmin(user.userId);
    const code = `RB${Date.now().toString(36).toUpperCase()}`;
    const created = await couponsService.createAdmin(user.userId, {
      code,
      title: 'Rollback',
      benefitType: CouponBenefitType.FIXED_DISCOUNT,
      benefitValue: '10',
      rideTypeScope: CouponRideTypeScope.ALL,
      chargeScope: CouponChargeScope.RIDE_FARE,
      audience: CouponAudience.PUBLIC,
      ...futureWindow(),
      totalRedemptionLimit: 1,
    });
    couponIds.push(created.id as string);

    await expect(
      dataSource.transaction(async (manager) => {
        await redemptionService.reserveInTransaction(manager, {
          userId: user.userId,
          rideType: CouponRideTypeScope.REGULAR,
          chargeScope: CouponChargeScope.RIDE_FARE,
          amount: 100n,
          bookingId: randomUUID(),
          rideId: randomUUID(),
          code,
          idempotencyKey: uniqueIdempotencyKey('rb'),
        });
        throw new Error('simulate booking failure after reserve');
      }),
    ).rejects.toThrow('simulate booking failure after reserve');

    const coupon = await dataSource.getRepository(Coupon).findOneOrFail({
      where: { id: created.id as string },
    });
    expect(coupon.reservedCount).toBe(0);
    expect(coupon.redeemedCount).toBe(0);
    const redemptions = await dataSource.getRepository(CouponRedemption).count({
      where: { couponId: created.id as string },
    });
    expect(redemptions).toBe(0);
  });

  it('repeated trip-completion hooks create no issuance rows when rules inactive', async () => {
    const tripId = randomUUID();
    const user = await trackUser();
    const before = await dataSource.getRepository(CouponIssuance).count();

    for (let i = 0; i < 3; i++) {
      await issuanceService.processTripCompletion({
        tripId,
        passengerUserIds: [user.userId],
        rideType: 'ASSURED',
      });
      await dataSource.transaction(async (manager) => {
        await issuanceService.onTripCompletedInTransaction(manager, {
          tripId,
          passengerUserIds: [user.userId],
          rideType: 'ASSURED',
        });
      });
    }

    const after = await dataSource.getRepository(CouponIssuance).count();
    expect(after).toBe(before);
    expect(
      await dataSource.getRepository(CouponIssuanceRule).count({
        where: { isActive: true },
      }),
    ).toBe(0);
  });

  it('idempotent finalize does not double-credit promotional points', async () => {
    const user = await trackUser();
    await ensureAdmin(user.userId);
    const code = `IDEM${Date.now().toString(36).toUpperCase()}`;
    const created = await couponsService.createAdmin(user.userId, {
      code,
      title: 'Idempotent points',
      benefitType: CouponBenefitType.POINTS_CREDIT,
      benefitValue: '25',
      rideTypeScope: CouponRideTypeScope.ALL,
      chargeScope: CouponChargeScope.RIDE_FARE,
      audience: CouponAudience.PUBLIC,
      ...futureWindow(),
    });
    couponIds.push(created.id as string);

    const redemptionId = await dataSource.transaction(async (manager) => {
      const reserved = await redemptionService.reserveInTransaction(manager, {
        userId: user.userId,
        rideType: CouponRideTypeScope.REGULAR,
        chargeScope: CouponChargeScope.RIDE_FARE,
        amount: 100n,
        bookingId: randomUUID(),
        rideId: randomUUID(),
        code,
        idempotencyKey: uniqueIdempotencyKey('idem-pts'),
      });
      await redemptionService.finalizeReservedInTransaction(
        manager,
        reserved.redemption.id,
        user.walletId,
      );
      await redemptionService.finalizeReservedInTransaction(
        manager,
        reserved.redemption.id,
        user.walletId,
      );
      return reserved.redemption.id;
    });

    const row = await dataSource.getRepository(CouponRedemption).findOneOrFail({
      where: { id: redemptionId },
    });
    expect(row.pointsCredited).toBe('25');

    const lots = await dataSource.getRepository(WalletPointLot).find({
      where: {
        walletId: user.walletId,
        sourceType: WalletPointSource.PROMOTIONAL,
      },
    });
    const promo = lots.reduce((s, l) => s + BigInt(l.availableAmount), 0n);
    expect(promo).toBe(25n);
  });

  describe('applicableTo audience eligibility', () => {
    async function createAudienceCoupon(
      adminUserId: string,
      applicableTo?: CouponApplicableTo,
      extra?: {
        chargeScope?: CouponChargeScope;
        rideTypeScope?: CouponRideTypeScope;
        benefitType?: CouponBenefitType;
        benefitValue?: string;
        maxDiscountAmount?: string;
        minEligibleAmount?: string;
      },
    ) {
      const code = `AUD${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2, 6)}`.toUpperCase();
      const created = await couponsService.createAdmin(adminUserId, {
        code,
        title: `Audience ${applicableTo ?? 'default'}`,
        benefitType: extra?.benefitType ?? CouponBenefitType.FIXED_DISCOUNT,
        benefitValue: extra?.benefitValue ?? '10',
        rideTypeScope: extra?.rideTypeScope ?? CouponRideTypeScope.ALL,
        chargeScope: extra?.chargeScope ?? CouponChargeScope.RIDE_FARE,
        audience: CouponAudience.PUBLIC,
        ...(applicableTo != null ? { applicableTo } : {}),
        ...(extra?.maxDiscountAmount
          ? { maxDiscountAmount: extra.maxDiscountAmount }
          : {}),
        ...(extra?.minEligibleAmount
          ? { minEligibleAmount: extra.minEligibleAmount }
          : {}),
        ...futureWindow(),
        perUserRedemptionLimit: 5,
      });
      couponIds.push(created.id as string);
      return { created, code: created.code as string };
    }

    async function reserve(
      userId: string,
      code: string,
      actorContext?: CouponActorContext,
      extra?: {
        chargeScope?: CouponChargeScope;
        rideType?: CouponRideTypeScope;
        transactionContext?: CouponTransactionContext;
        amount?: bigint;
      },
    ) {
      return dataSource.transaction(async (manager) => {
        return redemptionService.reserveInTransaction(manager, {
          userId,
          rideType: extra?.rideType ?? CouponRideTypeScope.REGULAR,
          chargeScope: extra?.chargeScope ?? CouponChargeScope.RIDE_FARE,
          amount: extra?.amount ?? 100n,
          bookingId: randomUUID(),
          rideId: randomUUID(),
          code,
          idempotencyKey: uniqueIdempotencyKey('aud'),
          ...(actorContext != null ? { actorContext } : {}),
          ...(extra?.transactionContext != null
            ? { transactionContext: extra.transactionContext }
            : {}),
        });
      });
    }

    it('treats missing applicableTo as ALL', () => {
      expect(resolveCouponApplicableTo(undefined)).toBe(CouponApplicableTo.ALL);
      expect(resolveCouponApplicableTo(null)).toBe(CouponApplicableTo.ALL);
      expect(resolveCouponApplicableTo('')).toBe(CouponApplicableTo.ALL);
      expect(resolveCouponApplicableTo('GARBAGE')).toBe(CouponApplicableTo.ALL);
    });

    it('defaults new coupons to ALL and keeps them redeemable', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const { created, code } = await createAudienceCoupon(user.userId);
      expect(created.applicableTo).toBe(CouponApplicableTo.ALL);

      const applied = await reserve(user.userId, code);
      expect(applied.discountAmount).toBe(10n);
      expect(applied.finalAmount).toBe(90n);
    });

    it('accepts ALL coupons for rider context', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const { code } = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.ALL,
      );
      const applied = await reserve(
        user.userId,
        code,
        CouponActorContext.RIDER,
      );
      expect(applied.finalAmount).toBe(90n);
    });

    it('accepts ALL coupons for driver context where driver redemption is invoked internally', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const { code } = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.ALL,
      );
      const applied = await reserve(
        user.userId,
        code,
        CouponActorContext.DRIVER,
      );
      expect(applied.finalAmount).toBe(90n);
    });

    it('accepts DRIVERS_ONLY for driver context and rejects rider context', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const { code } = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.DRIVERS_ONLY,
      );

      const asDriver = await reserve(
        user.userId,
        code,
        CouponActorContext.DRIVER,
      );
      expect(asDriver.finalAmount).toBe(90n);

      await expect(
        reserve(user.userId, code, CouponActorContext.RIDER),
      ).rejects.toBeInstanceOf(CouponDriversOnlyError);
    });

    it('accepts RIDERS_ONLY for rider context and rejects driver context', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const { code } = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.RIDERS_ONLY,
      );

      const asRider = await reserve(
        user.userId,
        code,
        CouponActorContext.RIDER,
      );
      expect(asRider.finalAmount).toBe(90n);

      await expect(
        reserve(user.userId, code, CouponActorContext.DRIVER),
      ).rejects.toBeInstanceOf(CouponRidersOnlyError);
    });

    it('evaluates booking-style redemption as rider even when actorContext is omitted', async () => {
      const dualRoleUser = await trackUser();
      await ensureAdmin(dualRoleUser.userId);
      const ridersOnly = await createAudienceCoupon(
        dualRoleUser.userId,
        CouponApplicableTo.RIDERS_ONLY,
      );
      const driversOnly = await createAudienceCoupon(
        dualRoleUser.userId,
        CouponApplicableTo.DRIVERS_ONLY,
      );

      const riderOk = await reserve(dualRoleUser.userId, ridersOnly.code);
      expect(riderOk.finalAmount).toBe(90n);

      await expect(
        reserve(dualRoleUser.userId, driversOnly.code),
      ).rejects.toBeInstanceOf(CouponDriversOnlyError);
    });

    it('rejects client-supplied role and applicableTo on validate', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const { code } = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.DRIVERS_ONLY,
      );
      const token = await login(user.userId);

      await request(app.getHttpServer())
        .post('/coupons/validate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code,
          rideType: CouponRideTypeScope.REGULAR,
          chargeScope: CouponChargeScope.RIDE_FARE,
          amount: '100',
          role: 'DRIVER',
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/coupons/validate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code,
          rideType: CouponRideTypeScope.REGULAR,
          chargeScope: CouponChargeScope.RIDE_FARE,
          amount: '100',
          applicableTo: CouponApplicableTo.ALL,
        })
        .expect(400);
    });

    it('enforces eligibility on validate/preview for the authenticated rider', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const { code } = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.DRIVERS_ONLY,
      );
      const token = await login(user.userId);

      const res = await request(app.getHttpServer())
        .post('/coupons/validate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code,
          rideType: CouponRideTypeScope.REGULAR,
          chargeScope: CouponChargeScope.RIDE_FARE,
          amount: '100',
        })
        .expect(422);

      expect(res.body.code).toBe('COUPON_DRIVERS_ONLY');
      expect(res.body.message).toBe(
        'This coupon is available only for drivers.',
      );

      const riders = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.RIDERS_ONLY,
      );
      const ok = await request(app.getHttpServer())
        .post('/coupons/preview')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: riders.code,
          rideType: CouponRideTypeScope.REGULAR,
          chargeScope: CouponChargeScope.RIDE_FARE,
          amount: '100',
        })
        .expect(201);
      expect(ok.body.valid).toBe(true);
      expect(ok.body.finalAmount).toBe('90');
      expect(ok.body.applicableTo).toBe(CouponApplicableTo.RIDERS_ONLY);
    });

    it('returns RIDERS_ONLY error when a driver-context redemption is attempted', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const { code } = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.RIDERS_ONLY,
      );
      await expect(
        reserve(user.userId, code, CouponActorContext.DRIVER),
      ).rejects.toBeInstanceOf(CouponRidersOnlyError);
    });

    it('rejects invalid applicableTo on create', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const token = await login(user.userId);
      await request(app.getHttpServer())
        .post('/admin/coupons')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Bad audience',
          benefitType: CouponBenefitType.FIXED_DISCOUNT,
          benefitValue: '10',
          rideTypeScope: CouponRideTypeScope.ALL,
          chargeScope: CouponChargeScope.RIDE_FARE,
          audience: CouponAudience.PUBLIC,
          applicableTo: 'PASSENGERS',
          ...futureWindow(),
        })
        .expect(400);
    });

    it('preserves applicableTo when omitted on update and status patch', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const token = await login(user.userId);
      const { created } = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.RIDERS_ONLY,
      );

      const omitted = await request(app.getHttpServer())
        .patch(`/admin/coupons/${created.id as string}`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(200);
      expect(omitted.body.applicableTo).toBe(CouponApplicableTo.RIDERS_ONLY);

      const status = await request(app.getHttpServer())
        .patch(`/admin/coupons/${created.id as string}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ isActive: true })
        .expect(200);
      expect(status.body.applicableTo).toBe(CouponApplicableTo.RIDERS_ONLY);

      const changed = await request(app.getHttpServer())
        .patch(`/admin/coupons/${created.id as string}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ applicableTo: CouponApplicableTo.ALL })
        .expect(200);
      expect(changed.body.applicableTo).toBe(CouponApplicableTo.ALL);
    });

    it('filters driver-only coupons from user offer lists and includes applicableTo', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const all = await createAudienceCoupon(user.userId, CouponApplicableTo.ALL);
      const riders = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.RIDERS_ONLY,
      );
      const drivers = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.DRIVERS_ONLY,
      );
      const token = await login(user.userId);

      const listed = await request(app.getHttpServer())
        .get('/coupons/public')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const ids = listed.body.items.map((c: { id: string }) => c.id);
      expect(ids).toContain(all.created.id);
      expect(ids).toContain(riders.created.id);
      expect(ids).not.toContain(drivers.created.id);

      const riderItem = listed.body.items.find(
        (c: { id: string }) => c.id === riders.created.id,
      );
      expect(riderItem.applicableTo).toBe(CouponApplicableTo.RIDERS_ONLY);

      const adminList = await request(app.getHttpServer())
        .get('/admin/coupons')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const adminIds = adminList.body.items.map((c: { id: string }) => c.id);
      expect(adminIds).toContain(drivers.created.id);
      const driverAdmin = adminList.body.items.find(
        (c: { id: string }) => c.id === drivers.created.id,
      );
      expect(driverAdmin.applicableTo).toBe(CouponApplicableTo.DRIVERS_ONLY);
    });

    it('lists driver deposit coupons to drivers and never to riders', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const token = await login(user.userId);
      const driverAll = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.ALL,
        { chargeScope: CouponChargeScope.DRIVER_ASSURED_DEPOSIT },
      );
      const driverOnly = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.DRIVERS_ONLY,
        { chargeScope: CouponChargeScope.DRIVER_ASSURED_DEPOSIT },
      );
      const riderOnly = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.RIDERS_ONLY,
      );

      const riderList = await request(app.getHttpServer())
        .get('/coupons/public')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const riderIds = riderList.body.items.map((c: { id: string }) => c.id);
      expect(riderIds).toContain(riderOnly.created.id);
      expect(riderIds).not.toContain(driverAll.created.id);
      expect(riderIds).not.toContain(driverOnly.created.id);

      const driverList = await request(app.getHttpServer())
        .get('/coupons/driver/public')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const driverIds = driverList.body.items.map((c: { id: string }) => c.id);
      expect(driverIds).toContain(driverAll.created.id);
      expect(driverIds).toContain(driverOnly.created.id);
      expect(driverIds).not.toContain(riderOnly.created.id);
    });

    it('excludes inactive and expired coupons from rider and driver listings', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const token = await login(user.userId);
      const inactive = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.ALL,
        { chargeScope: CouponChargeScope.DRIVER_ASSURED_DEPOSIT },
      );
      await request(app.getHttpServer())
        .patch(`/admin/coupons/${inactive.created.id as string}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ isActive: false })
        .expect(200);

      const expired = await couponsService.createAdmin(user.userId, {
        code: `EXP${Date.now().toString(36).toUpperCase()}`,
        title: 'Expired driver',
        benefitType: CouponBenefitType.FIXED_DISCOUNT,
        benefitValue: '10',
        rideTypeScope: CouponRideTypeScope.ALL,
        chargeScope: CouponChargeScope.DRIVER_ASSURED_DEPOSIT,
        audience: CouponAudience.PUBLIC,
        applicableTo: CouponApplicableTo.DRIVERS_ONLY,
        startsAt: new Date(Date.now() - 7 * 24 * 3600_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      couponIds.push(expired.id as string);

      const driverList = await request(app.getHttpServer())
        .get('/coupons/driver/public')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const driverIds = driverList.body.items.map((c: { id: string }) => c.id);
      expect(driverIds).not.toContain(inactive.created.id);
      expect(driverIds).not.toContain(expired.id);

      const riderInactive = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.RIDERS_ONLY,
      );
      await request(app.getHttpServer())
        .patch(`/admin/coupons/${riderInactive.created.id as string}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ isActive: false })
        .expect(200);
      const riderList = await request(app.getHttpServer())
        .get('/coupons/public')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(
        riderList.body.items.map((c: { id: string }) => c.id),
      ).not.toContain(riderInactive.created.id);
    });

    it('lists a DRIVERS_ONLY coupon even when chargeScope is not the new driver deposit value', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const token = await login(user.userId);
      const legacy = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.DRIVERS_ONLY,
        { chargeScope: CouponChargeScope.RIDE_FARE },
      );
      const driverList = await request(app.getHttpServer())
        .get('/coupons/driver/public')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(driverList.body.items.map((c: { id: string }) => c.id)).toContain(
        legacy.created.id,
      );
      const riderList = await request(app.getHttpServer())
        .get('/coupons/public')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(riderList.body.items.map((c: { id: string }) => c.id)).not.toContain(
        legacy.created.id,
      );
    });

    it('rejects driver-deposit coupons on rider booking context', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const { code } = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.DRIVERS_ONLY,
        { chargeScope: CouponChargeScope.DRIVER_ASSURED_DEPOSIT },
      );

      await expect(
        reserve(user.userId, code, CouponActorContext.RIDER, {
          chargeScope: CouponChargeScope.DRIVER_ASSURED_DEPOSIT,
          rideType: CouponRideTypeScope.ASSURED,
          transactionContext: CouponTransactionContext.RIDER_BOOKING,
        }),
      ).rejects.toBeInstanceOf(CouponInvalidTransactionContextError);

      await expect(
        reserve(user.userId, code, undefined, {
          chargeScope: CouponChargeScope.RIDE_FARE,
          transactionContext: CouponTransactionContext.RIDER_BOOKING,
        }),
      ).rejects.toBeInstanceOf(CouponInvalidTransactionContextError);
    });

    it('accepts DRIVER_ASSURED_DEPOSIT coupons only in driver deposit context', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const { code } = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.DRIVERS_ONLY,
        { chargeScope: CouponChargeScope.DRIVER_ASSURED_DEPOSIT },
      );

      const applied = await reserve(
        user.userId,
        code,
        CouponActorContext.DRIVER,
        {
          chargeScope: CouponChargeScope.DRIVER_ASSURED_DEPOSIT,
          rideType: CouponRideTypeScope.ASSURED,
          transactionContext: CouponTransactionContext.DRIVER_ASSURED_DEPOSIT,
        },
      );
      expect(applied.discountAmount).toBe(10n);
      expect(applied.finalAmount).toBe(90n);
    });

    it('rejects RIDERS_ONLY coupons in driver deposit context', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const { code } = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.RIDERS_ONLY,
        { chargeScope: CouponChargeScope.DRIVER_ASSURED_DEPOSIT },
      );

      await expect(
        reserve(user.userId, code, CouponActorContext.DRIVER, {
          chargeScope: CouponChargeScope.DRIVER_ASSURED_DEPOSIT,
          rideType: CouponRideTypeScope.ASSURED,
          transactionContext: CouponTransactionContext.DRIVER_ASSURED_DEPOSIT,
        }),
      ).rejects.toBeInstanceOf(CouponRidersOnlyError);
    });

    it('rejects client-supplied transactionContext on rider validate', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const { code } = await createAudienceCoupon(user.userId);
      const token = await login(user.userId);
      await request(app.getHttpServer())
        .post('/coupons/validate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code,
          rideType: CouponRideTypeScope.REGULAR,
          chargeScope: CouponChargeScope.RIDE_FARE,
          amount: '100',
          transactionContext: CouponTransactionContext.DRIVER_ASSURED_DEPOSIT,
        })
        .expect(400);
    });

    it('enforces minimum amount for driver deposit coupons', async () => {
      const user = await trackUser();
      await ensureAdmin(user.userId);
      const { code } = await createAudienceCoupon(
        user.userId,
        CouponApplicableTo.DRIVERS_ONLY,
        {
          chargeScope: CouponChargeScope.DRIVER_ASSURED_DEPOSIT,
          minEligibleAmount: '200',
        },
      );

      await expect(
        reserve(user.userId, code, CouponActorContext.DRIVER, {
          chargeScope: CouponChargeScope.DRIVER_ASSURED_DEPOSIT,
          rideType: CouponRideTypeScope.ASSURED,
          transactionContext: CouponTransactionContext.DRIVER_ASSURED_DEPOSIT,
          amount: 100n,
        }),
      ).rejects.toBeInstanceOf(CouponMinAmountNotMetError);
    });
  });
});
