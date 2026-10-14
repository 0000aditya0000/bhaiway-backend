import { CouponInvalidConfigError } from './errors/coupon.errors';
import {
  CouponAudience,
  CouponBenefitType,
  CouponChargeScope,
  CouponRideTypeScope,
  normalizeCouponCode,
} from './enums/coupon.enums';

export interface ParsedCouponConfig {
  code: string;
  codeNormalized: string;
  title: string;
  description: string | null;
  benefitType: CouponBenefitType;
  benefitValue: bigint;
  maxDiscountAmount: bigint | null;
  minEligibleAmount: bigint | null;
  rideTypeScope: CouponRideTypeScope;
  chargeScope: CouponChargeScope;
  audience: CouponAudience;
  startsAt: Date;
  expiresAt: Date;
  totalRedemptionLimit: number | null;
  perUserRedemptionLimit: number | null;
  isActive: boolean;
}

function parseNonNegativeBigInt(raw: string, field: string): bigint {
  if (!/^\d+$/.test(raw.trim())) {
    throw new CouponInvalidConfigError(`${field} must be a non-negative integer string.`);
  }
  const value = BigInt(raw.trim());
  if (value < 0n) {
    throw new CouponInvalidConfigError(`${field} must be non-negative.`);
  }
  return value;
}

export function validateAndParseCouponConfig(input: {
  code?: string;
  generatedCode?: string;
  title: string;
  description?: string;
  benefitType: CouponBenefitType;
  benefitValue: string;
  maxDiscountAmount?: string;
  minEligibleAmount?: string;
  rideTypeScope: CouponRideTypeScope;
  chargeScope: CouponChargeScope;
  audience: CouponAudience;
  startsAt: string;
  expiresAt: string;
  totalRedemptionLimit?: number | null;
  perUserRedemptionLimit?: number | null;
  isActive?: boolean;
}): ParsedCouponConfig {
  const codeRaw = (input.code ?? input.generatedCode ?? '').trim();
  if (!codeRaw) {
    throw new CouponInvalidConfigError('Coupon code is required.');
  }
  const codeNormalized = normalizeCouponCode(codeRaw);
  if (codeNormalized.length < 4 || codeNormalized.length > 64) {
    throw new CouponInvalidConfigError('Coupon code must be 4–64 characters.');
  }

  const benefitValue = parseNonNegativeBigInt(input.benefitValue, 'benefitValue');
  if (benefitValue === 0n) {
    throw new CouponInvalidConfigError('benefitValue must be greater than zero.');
  }

  let maxDiscountAmount: bigint | null = null;
  if (input.maxDiscountAmount != null && input.maxDiscountAmount !== '') {
    maxDiscountAmount = parseNonNegativeBigInt(
      input.maxDiscountAmount,
      'maxDiscountAmount',
    );
  }

  let minEligibleAmount: bigint | null = null;
  if (input.minEligibleAmount != null && input.minEligibleAmount !== '') {
    minEligibleAmount = parseNonNegativeBigInt(
      input.minEligibleAmount,
      'minEligibleAmount',
    );
  }

  if (input.benefitType === CouponBenefitType.PERCENTAGE_DISCOUNT) {
    if (benefitValue < 1n || benefitValue > 100n) {
      throw new CouponInvalidConfigError(
        'PERCENTAGE_DISCOUNT benefitValue must be between 1 and 100.',
      );
    }
  } else if (
    input.benefitType === CouponBenefitType.FIXED_DISCOUNT ||
    input.benefitType === CouponBenefitType.POINTS_CREDIT
  ) {
    if (maxDiscountAmount != null) {
      throw new CouponInvalidConfigError(
        'maxDiscountAmount is only valid for PERCENTAGE_DISCOUNT.',
      );
    }
  }

  if (input.benefitType === CouponBenefitType.POINTS_CREDIT) {
    if (input.chargeScope !== CouponChargeScope.RIDE_FARE) {
      // Points credit is not a fee discount; charge scope is informational for eligibility UX.
      // Allow any charge scope but document that POINTS_CREDIT never reduces deposit/fare.
    }
  } else {
    // Discount coupons must not pretend to be points credits.
    if (
      input.chargeScope !== CouponChargeScope.RIDE_FARE &&
      input.chargeScope !== CouponChargeScope.ASSURED_SECURITY_DEPOSIT &&
      input.chargeScope !== CouponChargeScope.BOTH
    ) {
      throw new CouponInvalidConfigError('Invalid chargeScope.');
    }
  }

  const startsAt = new Date(input.startsAt);
  const expiresAt = new Date(input.expiresAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(expiresAt.getTime())) {
    throw new CouponInvalidConfigError('Invalid validity dates.');
  }
  if (expiresAt <= startsAt) {
    throw new CouponInvalidConfigError('expiresAt must be after startsAt.');
  }

  if (
    input.totalRedemptionLimit != null &&
    (!Number.isInteger(input.totalRedemptionLimit) ||
      input.totalRedemptionLimit < 1)
  ) {
    throw new CouponInvalidConfigError('totalRedemptionLimit must be >= 1 or null.');
  }
  if (
    input.perUserRedemptionLimit != null &&
    (!Number.isInteger(input.perUserRedemptionLimit) ||
      input.perUserRedemptionLimit < 1)
  ) {
    throw new CouponInvalidConfigError('perUserRedemptionLimit must be >= 1 or null.');
  }

  if (
    input.audience === CouponAudience.USER_SPECIFIC &&
    input.rideTypeScope == null
  ) {
    throw new CouponInvalidConfigError('rideTypeScope is required.');
  }

  return {
    code: codeNormalized,
    codeNormalized,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    benefitType: input.benefitType,
    benefitValue,
    maxDiscountAmount,
    minEligibleAmount,
    rideTypeScope: input.rideTypeScope,
    chargeScope: input.chargeScope,
    audience: input.audience,
    startsAt,
    expiresAt,
    totalRedemptionLimit: input.totalRedemptionLimit ?? null,
    perUserRedemptionLimit: input.perUserRedemptionLimit ?? null,
    isActive: input.isActive ?? true,
  };
}

export function couponConfigSnapshot(coupon: {
  id: string;
  code: string;
  codeNormalized: string;
  title: string;
  benefitType: string;
  benefitValue: string;
  maxDiscountAmount: string | null;
  minEligibleAmount: string | null;
  rideTypeScope: string;
  chargeScope: string;
  audience: string;
  startsAt: Date;
  expiresAt: Date;
  totalRedemptionLimit: number | null;
  perUserRedemptionLimit: number | null;
}): Record<string, unknown> {
  return {
    id: coupon.id,
    code: coupon.code,
    codeNormalized: coupon.codeNormalized,
    title: coupon.title,
    benefitType: coupon.benefitType,
    benefitValue: coupon.benefitValue,
    maxDiscountAmount: coupon.maxDiscountAmount,
    minEligibleAmount: coupon.minEligibleAmount,
    rideTypeScope: coupon.rideTypeScope,
    chargeScope: coupon.chargeScope,
    audience: coupon.audience,
    startsAt: coupon.startsAt.toISOString(),
    expiresAt: coupon.expiresAt.toISOString(),
    totalRedemptionLimit: coupon.totalRedemptionLimit,
    perUserRedemptionLimit: coupon.perUserRedemptionLimit,
  };
}
