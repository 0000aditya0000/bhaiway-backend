import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import { WalletService } from '../wallet/wallet.service';
import { calculateCouponDiscount, pointsCreditIdempotencyKey } from './coupon.math';
import { couponConfigSnapshot } from './coupon.config';
import { CouponAssignment } from './entities/coupon-assignment.entity';
import { CouponRedemption } from './entities/coupon-redemption.entity';
import { Coupon } from './entities/coupon.entity';
import {
  CouponAlreadyRedeemedError,
  CouponAlreadyUsedError,
  CouponDriversOnlyError,
  CouponExhaustedError,
  CouponExpiredError,
  CouponInactiveError,
  CouponIneligibleError,
  CouponInvalidTransactionContextError,
  CouponMinAmountNotMetError,
  CouponNotAssignedError,
  CouponNotFoundError,
  CouponNotStartedError,
  CouponRidersOnlyError,
  CouponUsageLimitReachedError,
} from './errors/coupon.errors';
import {
  actorContextForTransaction,
  CouponActorContext,
  CouponApplicableTo,
  CouponAudience,
  CouponBenefitType,
  CouponChargeScope,
  CouponRedemptionStatus,
  CouponRideTypeScope,
  CouponTransactionContext,
  COUPON_REDEMPTION_REFERENCE_TYPE,
  isDriverAssuredDepositTransaction,
  normalizeCouponCode,
  resolveCouponApplicableTo,
} from './enums/coupon.enums';

export interface CouponEligibilityContext {
  userId: string;
  rideType: CouponRideTypeScope;
  chargeScope: CouponChargeScope;
  /** Authoritative eligible amount (fare or security fee). */
  amount: bigint;
  now?: Date;
  /**
   * Server-set rider/driver context. Never taken from the client.
   * Defaults from transactionContext, otherwise RIDER.
   */
  actorContext?: CouponActorContext;
  /**
   * Server-set transaction being charged. Never taken from the client.
   * Defaults to RIDER_BOOKING.
   */
  transactionContext?: CouponTransactionContext;
}

export interface ReserveCouponInput extends CouponEligibilityContext {
  bookingId?: string | null;
  rideId: string;
  code: string;
  idempotencyKey: string;
}

export interface AppliedCouponResult {
  redemption: CouponRedemption;
  originalAmount: bigint;
  discountAmount: bigint;
  finalAmount: bigint;
  pointsToCredit: bigint | null;
}

@Injectable()
export class CouponRedemptionService {
  constructor(
    @InjectRepository(Coupon)
    private readonly couponRepository: Repository<Coupon>,
    @InjectRepository(CouponAssignment)
    private readonly assignmentRepository: Repository<CouponAssignment>,
    @InjectRepository(CouponRedemption)
    private readonly redemptionRepository: Repository<CouponRedemption>,
    private readonly walletService: WalletService,
  ) {}

  async findByCodeNormalized(code: string): Promise<Coupon | null> {
    return this.couponRepository.findOne({
      where: { codeNormalized: normalizeCouponCode(code) },
    });
  }

  async preview(
    code: string,
    ctx: CouponEligibilityContext,
  ): Promise<{
    coupon: Coupon;
    originalAmount: bigint;
    discountAmount: bigint;
    finalAmount: bigint;
    pointsCredit: string | null;
  }> {
    const coupon = await this.requireCouponByCode(code);
    await this.assertEligible(coupon, ctx, { consumeCapacity: false });

    if (coupon.benefitType === CouponBenefitType.POINTS_CREDIT) {
      return {
        coupon,
        originalAmount: ctx.amount,
        discountAmount: 0n,
        finalAmount: ctx.amount,
        pointsCredit: coupon.benefitValue,
      };
    }

    const calc = calculateCouponDiscount(ctx.amount, {
      benefitType: coupon.benefitType,
      benefitValue: BigInt(coupon.benefitValue),
      maxDiscountAmount:
        coupon.maxDiscountAmount != null
          ? BigInt(coupon.maxDiscountAmount)
          : null,
      minEligibleAmount:
        coupon.minEligibleAmount != null
          ? BigInt(coupon.minEligibleAmount)
          : null,
    });

    if (
      coupon.minEligibleAmount != null &&
      ctx.amount < BigInt(coupon.minEligibleAmount)
    ) {
      this.throwMinAmountNotMet(ctx);
    }

    return {
      coupon,
      originalAmount: calc.originalAmount,
      discountAmount: calc.discountAmount,
      finalAmount: calc.finalAmount,
      pointsCredit: null,
    };
  }

  /**
   * Reserve + apply discount math inside an existing booking transaction.
   * Caller must charge/hold only `finalAmount`. Finalize with finalizeReserved
   * after successful payment/hold, or releaseReserved on failure.
   */
  async reserveInTransaction(
    manager: EntityManager,
    input: ReserveCouponInput,
  ): Promise<AppliedCouponResult> {
    const existing = await manager.getRepository(CouponRedemption).findOne({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      if (
        existing.status === CouponRedemptionStatus.RELEASED ||
        existing.status === CouponRedemptionStatus.FAILED
      ) {
        throw new CouponIneligibleError(
          'This coupon reservation is no longer available.',
        );
      }
      return {
        redemption: existing,
        originalAmount: BigInt(existing.originalAmount),
        discountAmount: BigInt(existing.discountAmount),
        finalAmount: BigInt(existing.finalAmount),
        pointsToCredit:
          existing.pointsCredited != null
            ? BigInt(existing.pointsCredited)
            : existing.benefitTypeSnapshot === CouponBenefitType.POINTS_CREDIT
              ? BigInt(existing.benefitValueSnapshot)
              : null,
      };
    }

    const coupon = await manager
      .getRepository(Coupon)
      .createQueryBuilder('c')
      .setLock('pessimistic_write')
      .where('c.code_normalized = :code', {
        code: normalizeCouponCode(input.code),
      })
      .getOne();

    if (!coupon) {
      throw new CouponNotFoundError();
    }

    await this.assertEligible(coupon, input, {
      consumeCapacity: true,
      manager,
    });

    let discountAmount = 0n;
    let finalAmount = input.amount;
    let pointsToCredit: bigint | null = null;

    if (coupon.benefitType === CouponBenefitType.POINTS_CREDIT) {
      pointsToCredit = BigInt(coupon.benefitValue);
    } else {
      if (
        coupon.minEligibleAmount != null &&
        input.amount < BigInt(coupon.minEligibleAmount)
      ) {
        this.throwMinAmountNotMet(input);
      }
      const calc = calculateCouponDiscount(input.amount, {
        benefitType: coupon.benefitType,
        benefitValue: BigInt(coupon.benefitValue),
        maxDiscountAmount:
          coupon.maxDiscountAmount != null
            ? BigInt(coupon.maxDiscountAmount)
            : null,
        minEligibleAmount:
          coupon.minEligibleAmount != null
            ? BigInt(coupon.minEligibleAmount)
            : null,
      });
      discountAmount = calc.discountAmount;
      finalAmount = calc.finalAmount;
    }

    coupon.reservedCount += 1;
    await manager.getRepository(Coupon).save(coupon);

    const redemption = manager.getRepository(CouponRedemption).create({
      couponId: coupon.id,
      userId: input.userId,
      status: CouponRedemptionStatus.RESERVED,
      bookingId: input.bookingId ?? null,
      rideId: input.rideId,
      rideTypeScope: input.rideType,
      chargeScope: input.chargeScope,
      benefitTypeSnapshot: coupon.benefitType,
      benefitValueSnapshot: coupon.benefitValue,
      codeSnapshot: coupon.codeNormalized,
      originalAmount: input.amount.toString(),
      discountAmount: discountAmount.toString(),
      finalAmount: finalAmount.toString(),
      pointsCredited: null,
      idempotencyKey: input.idempotencyKey,
      configSnapshot: couponConfigSnapshot(coupon),
      reservedAt: new Date(),
    });

    const saved = await manager.getRepository(CouponRedemption).save(redemption);

    return {
      redemption: saved,
      originalAmount: input.amount,
      discountAmount,
      finalAmount,
      pointsToCredit,
    };
  }

  async finalizeReservedInTransaction(
    manager: EntityManager,
    redemptionId: string,
    walletId?: string,
  ): Promise<CouponRedemption> {
    const redemption = await manager
      .getRepository(CouponRedemption)
      .createQueryBuilder('r')
      .setLock('pessimistic_write')
      .where('r.id = :id', { id: redemptionId })
      .getOne();

    if (!redemption) {
      throw new CouponNotFoundError('Coupon redemption not found.');
    }

    if (redemption.status === CouponRedemptionStatus.REDEEMED) {
      return redemption;
    }
    if (redemption.status !== CouponRedemptionStatus.RESERVED) {
      throw new CouponIneligibleError(
        `Cannot finalize redemption in status ${redemption.status}.`,
      );
    }

    const coupon = await manager
      .getRepository(Coupon)
      .createQueryBuilder('c')
      .setLock('pessimistic_write')
      .where('c.id = :id', { id: redemption.couponId })
      .getOne();

    if (!coupon) {
      throw new CouponNotFoundError();
    }

    if (coupon.reservedCount > 0) {
      coupon.reservedCount -= 1;
    }
    coupon.redeemedCount += 1;

    redemption.status = CouponRedemptionStatus.REDEEMED;
    redemption.redeemedAt = new Date();

    if (
      redemption.benefitTypeSnapshot === CouponBenefitType.POINTS_CREDIT &&
      walletId
    ) {
      const points = BigInt(redemption.benefitValueSnapshot);
      const credit = await this.walletService.creditPointsInTransaction(
        manager,
        {
          walletId,
          userId: redemption.userId,
          amount: points,
          sourceType: WalletPointSource.PROMOTIONAL,
          referenceType: COUPON_REDEMPTION_REFERENCE_TYPE,
          referenceId: redemption.id,
          idempotencyKey: pointsCreditIdempotencyKey(redemption.id),
        },
      );
      redemption.pointsCredited = points.toString();
      redemption.walletTransactionId = credit.transaction.id;
    }

    await manager.getRepository(Coupon).save(coupon);
    return manager.getRepository(CouponRedemption).save(redemption);
  }

  async releaseReservedInTransaction(
    manager: EntityManager,
    redemptionId: string,
    failed = false,
  ): Promise<CouponRedemption | null> {
    const redemption = await manager
      .getRepository(CouponRedemption)
      .createQueryBuilder('r')
      .setLock('pessimistic_write')
      .where('r.id = :id', { id: redemptionId })
      .getOne();

    if (!redemption) {
      return null;
    }

    if (
      redemption.status === CouponRedemptionStatus.RELEASED ||
      redemption.status === CouponRedemptionStatus.FAILED
    ) {
      return redemption;
    }

    if (redemption.status === CouponRedemptionStatus.REDEEMED) {
      // Completed redemptions are immutable for capacity.
      return redemption;
    }

    const coupon = await manager
      .getRepository(Coupon)
      .createQueryBuilder('c')
      .setLock('pessimistic_write')
      .where('c.id = :id', { id: redemption.couponId })
      .getOne();

    if (coupon && coupon.reservedCount > 0) {
      coupon.reservedCount -= 1;
      await manager.getRepository(Coupon).save(coupon);
    }

    redemption.status = failed
      ? CouponRedemptionStatus.FAILED
      : CouponRedemptionStatus.RELEASED;
    redemption.releasedAt = new Date();
    return manager.getRepository(CouponRedemption).save(redemption);
  }

  async releaseByBookingIdInTransaction(
    manager: EntityManager,
    bookingId: string,
  ): Promise<void> {
    const rows = await manager.getRepository(CouponRedemption).find({
      where: {
        bookingId,
        status: CouponRedemptionStatus.RESERVED,
      },
    });
    for (const row of rows) {
      await this.releaseReservedInTransaction(manager, row.id, false);
    }
  }

  private async requireCouponByCode(code: string): Promise<Coupon> {
    const coupon = await this.findByCodeNormalized(code);
    if (!coupon) {
      throw new CouponNotFoundError();
    }
    return coupon;
  }

  private async assertEligible(
    coupon: Coupon,
    ctx: CouponEligibilityContext,
    options: { consumeCapacity: boolean; manager?: EntityManager },
  ): Promise<void> {
    const now = ctx.now ?? new Date();

    if (!coupon.isActive) {
      throw new CouponInactiveError();
    }
    if (now < coupon.startsAt) {
      throw new CouponNotStartedError();
    }
    if (now > coupon.expiresAt) {
      throw new CouponExpiredError();
    }

    if (
      coupon.rideTypeScope !== CouponRideTypeScope.ALL &&
      coupon.rideTypeScope !== ctx.rideType
    ) {
      throw new CouponIneligibleError(
        'This coupon is not valid for this ride type.',
      );
    }

    this.assertTransactionAndCharge(coupon, ctx);
    this.assertApplicableToActor(coupon, ctx);

    if (coupon.audience === CouponAudience.USER_SPECIFIC) {
      const assignmentRepo =
        options.manager?.getRepository(CouponAssignment) ??
        this.assignmentRepository;
      const assignment = await assignmentRepo.findOne({
        where: { couponId: coupon.id, userId: ctx.userId },
      });
      if (!assignment) {
        throw new CouponNotAssignedError();
      }
    }

    const activeStatuses = [
      CouponRedemptionStatus.RESERVED,
      CouponRedemptionStatus.REDEEMED,
    ];

    const redemptionRepo =
      options.manager?.getRepository(CouponRedemption) ??
      this.redemptionRepository;

    if (coupon.perUserRedemptionLimit != null) {
      const userCount = await redemptionRepo
        .createQueryBuilder('r')
        .where('r.coupon_id = :couponId', { couponId: coupon.id })
        .andWhere('r.user_id = :userId', { userId: ctx.userId })
        .andWhere('r.status IN (:...statuses)', { statuses: activeStatuses })
        .getCount();
      if (userCount >= coupon.perUserRedemptionLimit) {
        this.throwPerUserLimit(ctx);
      }
    }

    if (options.consumeCapacity && coupon.totalRedemptionLimit != null) {
      const used = coupon.redeemedCount + coupon.reservedCount;
      if (used >= coupon.totalRedemptionLimit) {
        this.throwGlobalLimit(ctx);
      }
    } else if (
      !options.consumeCapacity &&
      coupon.totalRedemptionLimit != null
    ) {
      const used = coupon.redeemedCount + coupon.reservedCount;
      if (used >= coupon.totalRedemptionLimit) {
        this.throwGlobalLimit(ctx);
      }
    }
  }

  private resolveTransactionContext(
    ctx: CouponEligibilityContext,
  ): CouponTransactionContext {
    return ctx.transactionContext ?? CouponTransactionContext.RIDER_BOOKING;
  }

  private throwMinAmountNotMet(ctx: CouponEligibilityContext): never {
    if (isDriverAssuredDepositTransaction(this.resolveTransactionContext(ctx))) {
      throw new CouponMinAmountNotMetError();
    }
    throw new CouponIneligibleError(
      'Charge amount is below the coupon minimum.',
    );
  }

  private throwPerUserLimit(ctx: CouponEligibilityContext): never {
    if (isDriverAssuredDepositTransaction(this.resolveTransactionContext(ctx))) {
      throw new CouponAlreadyRedeemedError();
    }
    throw new CouponAlreadyUsedError();
  }

  private throwGlobalLimit(ctx: CouponEligibilityContext): never {
    if (isDriverAssuredDepositTransaction(this.resolveTransactionContext(ctx))) {
      throw new CouponUsageLimitReachedError();
    }
    throw new CouponExhaustedError();
  }

  /**
   * Charge + transaction matching. Transaction context is always server-set.
   */
  private assertTransactionAndCharge(
    coupon: Coupon,
    ctx: CouponEligibilityContext,
  ): void {
    if (ctx.chargeScope === CouponChargeScope.BOTH) {
      throw new CouponIneligibleError(
        'Specify RIDE_FARE or ASSURED_SECURITY_DEPOSIT when applying a coupon.',
      );
    }

    const tx = this.resolveTransactionContext(ctx);

    if (tx === CouponTransactionContext.DRIVER_ASSURED_DEPOSIT) {
      if (
        ctx.chargeScope !== CouponChargeScope.DRIVER_ASSURED_DEPOSIT ||
        coupon.chargeScope !== CouponChargeScope.DRIVER_ASSURED_DEPOSIT
      ) {
        throw new CouponInvalidTransactionContextError();
      }
      return;
    }

    if (
      ctx.chargeScope === CouponChargeScope.DRIVER_ASSURED_DEPOSIT ||
      coupon.chargeScope === CouponChargeScope.DRIVER_ASSURED_DEPOSIT
    ) {
      throw new CouponInvalidTransactionContextError();
    }

    if (!this.chargeScopeMatches(coupon.chargeScope, ctx.chargeScope)) {
      throw new CouponIneligibleError(
        'This coupon is not valid for this charge type.',
      );
    }
  }

  /**
   * Rider/driver eligibility. Actor is always server-set.
   * Client-supplied role / applicableTo / transactionContext never enter this context.
   */
  private assertApplicableToActor(
    coupon: Coupon,
    ctx: CouponEligibilityContext,
  ): void {
    const applicableTo = resolveCouponApplicableTo(coupon.applicableTo);
    const actor =
      ctx.actorContext ??
      actorContextForTransaction(this.resolveTransactionContext(ctx));

    if (
      applicableTo === CouponApplicableTo.DRIVERS_ONLY &&
      actor !== CouponActorContext.DRIVER
    ) {
      throw new CouponDriversOnlyError();
    }
    if (
      applicableTo === CouponApplicableTo.RIDERS_ONLY &&
      actor !== CouponActorContext.RIDER
    ) {
      throw new CouponRidersOnlyError();
    }
  }

  private chargeScopeMatches(
    couponScope: CouponChargeScope,
    requested: CouponChargeScope,
  ): boolean {
    if (couponScope === CouponChargeScope.BOTH) {
      return (
        requested === CouponChargeScope.RIDE_FARE ||
        requested === CouponChargeScope.ASSURED_SECURITY_DEPOSIT
      );
    }
    return couponScope === requested;
  }
}
