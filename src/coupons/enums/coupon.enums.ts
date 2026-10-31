export enum CouponBenefitType {
  POINTS_CREDIT = 'POINTS_CREDIT',
  FIXED_DISCOUNT = 'FIXED_DISCOUNT',
  PERCENTAGE_DISCOUNT = 'PERCENTAGE_DISCOUNT',
}

export enum CouponAudience {
  PUBLIC = 'PUBLIC',
  USER_SPECIFIC = 'USER_SPECIFIC',
}

/**
 * Who may redeem a catalog coupon. Distinct from `CouponAudience`
 * (PUBLIC vs USER_SPECIFIC assignment).
 */
export enum CouponApplicableTo {
  ALL = 'ALL',
  DRIVERS_ONLY = 'DRIVERS_ONLY',
  RIDERS_ONLY = 'RIDERS_ONLY',
}

/**
 * Server-resolved transaction context. Never accepted from the client.
 * Booking/payment coupon paths always use RIDER; DRIVER is reserved for a
 * future driver-side redemption flow that does not exist today.
 */
export enum CouponActorContext {
  RIDER = 'RIDER',
  DRIVER = 'DRIVER',
}

/** User offer lists are booking-oriented (rider context). */
export const USER_LISTING_APPLICABLE_TO: CouponApplicableTo[] = [
  CouponApplicableTo.ALL,
  CouponApplicableTo.RIDERS_ONLY,
];

export function resolveCouponApplicableTo(
  value?: string | null,
): CouponApplicableTo {
  if (
    value === CouponApplicableTo.DRIVERS_ONLY ||
    value === CouponApplicableTo.RIDERS_ONLY ||
    value === CouponApplicableTo.ALL
  ) {
    return value;
  }
  return CouponApplicableTo.ALL;
}

/** Mirrors RideType plus ALL. */
export enum CouponRideTypeScope {
  ALL = 'ALL',
  REGULAR = 'REGULAR',
  ASSURED = 'ASSURED',
  OFFICE_COMMUTE = 'OFFICE_COMMUTE',
}

export enum CouponChargeScope {
  RIDE_FARE = 'RIDE_FARE',
  ASSURED_SECURITY_DEPOSIT = 'ASSURED_SECURITY_DEPOSIT',
  BOTH = 'BOTH',
}

export enum CouponRedemptionStatus {
  RESERVED = 'RESERVED',
  REDEEMED = 'REDEEMED',
  RELEASED = 'RELEASED',
  FAILED = 'FAILED',
}

export enum CouponIssuanceSource {
  ADMIN = 'ADMIN',
  AUTOMATIC_TRIP_COMPLETION = 'AUTOMATIC_TRIP_COMPLETION',
}

export enum CouponIssuanceStatus {
  PENDING = 'PENDING',
  ISSUED = 'ISSUED',
  FAILED = 'FAILED',
}

export const COUPON_REFERENCE_TYPE = 'COUPON';
export const COUPON_REDEMPTION_REFERENCE_TYPE = 'COUPON_REDEMPTION';

export function normalizeCouponCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function mapRideTypeToCouponScope(
  rideType: string,
): CouponRideTypeScope {
  if (rideType === 'COMMUTE') {
    return CouponRideTypeScope.OFFICE_COMMUTE;
  }
  if (rideType === 'ASSURED') {
    return CouponRideTypeScope.ASSURED;
  }
  if (rideType === 'REGULAR') {
    return CouponRideTypeScope.REGULAR;
  }
  return CouponRideTypeScope.ALL;
}
