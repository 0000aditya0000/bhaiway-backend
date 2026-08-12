/**
 * Assured Ride security-deposit math.
 * All amounts are integer Points (1 Point = ₹1). No floating point.
 */

/**
 * ROUND HALF UP: (baseAmount × percentage) / 100
 *
 * Examples (percentage = 5):
 * - 2000 → 100
 * - 500 → 25
 * - 333 → 17 (16.65 rounds up)
 * - 329 → 16 (16.45 rounds down)
 */
export function calculateAssuredDepositAmount(
  baseAmount: bigint,
  percentage: number,
): bigint {
  if (baseAmount < 0n) {
    throw new Error('Deposit base amount cannot be negative');
  }
  if (!Number.isInteger(percentage) || percentage <= 0 || percentage > 100) {
    throw new Error('Deposit percentage must be an integer from 1 to 100');
  }

  const product = baseAmount * BigInt(percentage);
  return (product + 50n) / 100n;
}

export function calculateDriverAssuredDeposit(
  totalPublishedSeats: number,
  pricePerSeat: bigint,
  percentage: number,
): bigint {
  if (!Number.isInteger(totalPublishedSeats) || totalPublishedSeats <= 0) {
    throw new Error('Published seats must be a positive integer');
  }
  const base = BigInt(totalPublishedSeats) * pricePerSeat;
  return calculateAssuredDepositAmount(base, percentage);
}

export function calculateRiderAssuredDeposit(
  bookedSeats: number,
  pricePerSeat: bigint,
  percentage: number,
): bigint {
  if (!Number.isInteger(bookedSeats) || bookedSeats <= 0) {
    throw new Error('Booked seats must be a positive integer');
  }
  const base = BigInt(bookedSeats) * pricePerSeat;
  return calculateAssuredDepositAmount(base, percentage);
}

export const ASSURED_RIDE_DRIVER_DEPOSIT_REF = 'ASSURED_RIDE_DRIVER_DEPOSIT';
export const ASSURED_BOOKING_RIDER_DEPOSIT_REF = 'ASSURED_BOOKING_RIDER_DEPOSIT';
