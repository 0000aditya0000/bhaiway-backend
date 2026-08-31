import { percentOfAmountHalfUp } from '../assured/assured-lifecycle.math';

/** Passenger-facing markup on Daily Office Commute driver-published fare. */
export const COMMUTE_RIDER_MARKUP_PERCENT = 10;

/**
 * Rider price per seat = driver price + 10% markup (integer points, HALF UP on markup).
 * Example: driver ₹100 → rider ₹110; driver ₹333 → rider ₹366.
 */
export function computeCommuteRiderPricePerSeat(
  driverPricePerSeat: string | bigint,
): string {
  const driver =
    typeof driverPricePerSeat === 'bigint'
      ? driverPricePerSeat
      : BigInt(driverPricePerSeat);
  if (driver < 0n) {
    throw new Error('Driver price cannot be negative');
  }
  const markup = percentOfAmountHalfUp(driver, COMMUTE_RIDER_MARKUP_PERCENT);
  return (driver + markup).toString();
}

export interface CommuteBookingFareSnapshots {
  driverPricePerSeatSnapshot: string;
  riderPricePerSeatSnapshot: string;
  driverShareAmount: string;
  platformShareAmount: string;
  totalAmount: string;
}

/**
 * Immutable Commute booking fare snapshots from the ride's driver-published fare.
 * totalAmount is the rider-paid debit (rider fare × seats).
 */
export function computeCommuteBookingFareSnapshots(
  driverPricePerSeat: string | bigint,
  seats: number,
): CommuteBookingFareSnapshots {
  if (!Number.isInteger(seats) || seats < 1) {
    throw new Error('Seats must be a positive integer');
  }
  const driverPerSeat =
    typeof driverPricePerSeat === 'bigint'
      ? driverPricePerSeat
      : BigInt(driverPricePerSeat);
  const riderPerSeat = BigInt(
    computeCommuteRiderPricePerSeat(driverPerSeat),
  );
  const seatCount = BigInt(seats);
  const driverShareAmount = driverPerSeat * seatCount;
  const totalAmount = riderPerSeat * seatCount;
  const platformShareAmount = totalAmount - driverShareAmount;

  return {
    driverPricePerSeatSnapshot: driverPerSeat.toString(),
    riderPricePerSeatSnapshot: riderPerSeat.toString(),
    driverShareAmount: driverShareAmount.toString(),
    platformShareAmount: platformShareAmount.toString(),
    totalAmount: totalAmount.toString(),
  };
}
