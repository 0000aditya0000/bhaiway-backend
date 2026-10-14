import { calculateCouponDiscount } from './coupon.math';
import { CouponBenefitType } from './enums/coupon.enums';

describe('calculateCouponDiscount', () => {
  it('applies fixed discount and never goes negative', () => {
    const result = calculateCouponDiscount(200n, {
      benefitType: CouponBenefitType.FIXED_DISCOUNT,
      benefitValue: 50n,
      maxDiscountAmount: null,
      minEligibleAmount: null,
    });
    expect(result).toEqual({
      originalAmount: 200n,
      discountAmount: 50n,
      finalAmount: 150n,
    });
  });

  it('caps fixed discount at original amount', () => {
    const result = calculateCouponDiscount(40n, {
      benefitType: CouponBenefitType.FIXED_DISCOUNT,
      benefitValue: 100n,
      maxDiscountAmount: null,
      minEligibleAmount: null,
    });
    expect(result.discountAmount).toBe(40n);
    expect(result.finalAmount).toBe(0n);
  });

  it('applies percentage with max cap', () => {
    const result = calculateCouponDiscount(1000n, {
      benefitType: CouponBenefitType.PERCENTAGE_DISCOUNT,
      benefitValue: 20n,
      maxDiscountAmount: 100n,
      minEligibleAmount: null,
    });
    expect(result.discountAmount).toBe(100n);
    expect(result.finalAmount).toBe(900n);
  });

  it('returns zero discount below minimum eligible amount', () => {
    const result = calculateCouponDiscount(50n, {
      benefitType: CouponBenefitType.FIXED_DISCOUNT,
      benefitValue: 20n,
      maxDiscountAmount: null,
      minEligibleAmount: 100n,
    });
    expect(result.discountAmount).toBe(0n);
    expect(result.finalAmount).toBe(50n);
  });
});
