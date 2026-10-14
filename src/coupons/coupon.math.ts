import { CouponBenefitType } from './enums/coupon.enums';

export interface DiscountCouponConfig {
  benefitType: CouponBenefitType;
  /** Fixed points or percentage (0–100), depending on benefit type. */
  benefitValue: bigint;
  maxDiscountAmount: bigint | null;
  minEligibleAmount: bigint | null;
}

export interface DiscountCalculationResult {
  originalAmount: bigint;
  discountAmount: bigint;
  finalAmount: bigint;
}

/**
 * Authoritative discount math for FIXED / PERCENTAGE coupons.
 * Never returns a negative final amount.
 */
export function calculateCouponDiscount(
  originalAmount: bigint,
  config: DiscountCouponConfig,
): DiscountCalculationResult {
  if (originalAmount < 0n) {
    throw new Error('originalAmount must be non-negative');
  }

  if (
    config.benefitType !== CouponBenefitType.FIXED_DISCOUNT &&
    config.benefitType !== CouponBenefitType.PERCENTAGE_DISCOUNT
  ) {
    throw new Error('Discount calculation requires a discount benefit type');
  }

  if (
    config.minEligibleAmount != null &&
    originalAmount < config.minEligibleAmount
  ) {
    return {
      originalAmount,
      discountAmount: 0n,
      finalAmount: originalAmount,
    };
  }

  let discount = 0n;
  if (config.benefitType === CouponBenefitType.FIXED_DISCOUNT) {
    discount = config.benefitValue;
  } else {
    // Round half up: (amount * pct + 50) / 100
    discount = (originalAmount * config.benefitValue + 50n) / 100n;
    if (config.maxDiscountAmount != null && discount > config.maxDiscountAmount) {
      discount = config.maxDiscountAmount;
    }
  }

  if (discount < 0n) {
    discount = 0n;
  }
  if (discount > originalAmount) {
    discount = originalAmount;
  }

  return {
    originalAmount,
    discountAmount: discount,
    finalAmount: originalAmount - discount,
  };
}

export function pointsCreditIdempotencyKey(redemptionId: string): string {
  return `coupon-points-credit:${redemptionId}`;
}
