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
 * Server-resolved actor for audience checks. Never accepted from the client.
 */
export enum CouponActorContext {
  RIDER = 'RIDER',
  DRIVER = 'DRIVER',
}

/**
 * Server-resolved transaction that is redeeming a coupon.
 * Never accepted from the client. Extensible for future driver-side charges.
 */
export enum CouponTransactionContext {
  RIDER_BOOKING = 'RIDER_BOOKING',
  DRIVER_ASSURED_DEPOSIT = 'DRIVER_ASSURED_DEPOSIT',
}

/** Rider offer lists (booking-oriented). */
export const USER_LISTING_APPLICABLE_TO: CouponApplicableTo[] = [
  CouponApplicableTo.ALL,
  CouponApplicableTo.RIDERS_ONLY,
];

/** Driver offer lists (Assured driver-deposit-oriented). */
export const DRIVER_LISTING_APPLICABLE_TO: CouponApplicableTo[] = [
  CouponApplicableTo.ALL,
  CouponApplicableTo.DRIVERS_ONLY,
];

export function actorContextForTransaction(
  tx?: CouponTransactionContext | null,
): CouponActorContext {
  if (tx === CouponTransactionContext.DRIVER_ASSURED_DEPOSIT) {
    return CouponActorContext.DRIVER;
  }
  return CouponActorContext.RIDER;
}

export function isDriverAssuredDepositTransaction(
  tx?: CouponTransactionContext | null,
): boolean {
  return tx === CouponTransactionContext.DRIVER_ASSURED_DEPOSIT;
}

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
  /** Rider Assured security deposit (booking). */
  ASSURED_SECURITY_DEPOSIT = 'ASSURED_SECURITY_DEPOSIT',
  /**
   * Driver Assured Ride security deposit (publish hold).
   * Distinct from ASSURED_SECURITY_DEPOSIT. BOTH does not include this.
   */
  DRIVER_ASSURED_DEPOSIT = 'DRIVER_ASSURED_DEPOSIT',
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
