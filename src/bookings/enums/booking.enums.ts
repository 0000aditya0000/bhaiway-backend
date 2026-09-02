export enum BookingStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
}

export enum BookingPaymentMethod {
  PAY_NOW = 'PAY_NOW',
  PAY_LATER = 'PAY_LATER',
  ASSURED_DEPOSIT = 'ASSURED_DEPOSIT',
}

/**
 * Assured fare choice independent of the mandatory security deposit.
 * Only meaningful when paymentMethod === ASSURED_DEPOSIT.
 */
export enum BookingFarePayment {
  PAY_NOW = 'PAY_NOW',
  PAY_LATER = 'PAY_LATER',
}

export enum BookingPaymentStatus {
  UNPAID = 'UNPAID',
  PAID = 'PAID',
  REFUNDED = 'REFUNDED',
}

/** Whether the passenger booked under Assured deposit rules, Regular fare rules, or Commute request flow. */
export enum BookingMode {
  ASSURED = 'ASSURED',
  REGULAR = 'REGULAR',
  /** Daily Office Commute: pay at request, PENDING until driver accepts. */
  COMMUTE = 'COMMUTE',
}

export enum BookingCancellationReason {
  RIDER_CANCELLED = 'RIDER_CANCELLED',
  RIDER_NO_SHOW = 'RIDER_NO_SHOW',
  RIDE_CANCELLED = 'RIDE_CANCELLED',
  DRIVER_NO_SHOW = 'DRIVER_NO_SHOW',
  /** Commute driver rejected a PENDING request (full rider refund). */
  DRIVER_REJECTED = 'DRIVER_REJECTED',
  /** Commute ride became full; remaining PENDING requests auto-cancelled with full refund. */
  COMMUTE_RIDE_FULL = 'COMMUTE_RIDE_FULL',
}

/**
 * Passenger boarding state for Regular rides.
 * Independent of BookingStatus (CONFIRMED stays until ride completion).
 */
export enum BookingPickupStatus {
  WAITING_FOR_PICKUP = 'WAITING_FOR_PICKUP',
  PICKED_UP = 'PICKED_UP',
}
