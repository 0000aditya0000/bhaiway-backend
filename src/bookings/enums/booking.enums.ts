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

export enum BookingPaymentStatus {
  UNPAID = 'UNPAID',
  PAID = 'PAID',
}

/** Whether the passenger booked under Assured deposit rules or Regular fare rules. */
export enum BookingMode {
  ASSURED = 'ASSURED',
  REGULAR = 'REGULAR',
}

export enum BookingCancellationReason {
  RIDER_CANCELLED = 'RIDER_CANCELLED',
  RIDER_NO_SHOW = 'RIDER_NO_SHOW',
  RIDE_CANCELLED = 'RIDE_CANCELLED',
  DRIVER_NO_SHOW = 'DRIVER_NO_SHOW',
}

/**
 * Passenger boarding state for Regular rides.
 * Independent of BookingStatus (CONFIRMED stays until ride completion).
 */
export enum BookingPickupStatus {
  WAITING_FOR_PICKUP = 'WAITING_FOR_PICKUP',
  PICKED_UP = 'PICKED_UP',
}
