import {
  BookingMode,
  BookingPickupStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';

export interface BookingPassengerEvidence {
  passengerId: string;
  status: BookingStatus;
  bookingMode: BookingMode;
  pickupStatus: BookingPickupStatus | null;
}

/**
 * Authoritative qualifying passenger: Office Commute booking that completed
 * the trip with verified pickup. Booked-only (CONFIRMED without pickup) and
 * PENDING requests do not count.
 */
export function isQualifyingCompletedPassenger(
  booking: BookingPassengerEvidence,
): boolean {
  return (
    booking.bookingMode === BookingMode.COMMUTE &&
    booking.status === BookingStatus.COMPLETED &&
    booking.pickupStatus === BookingPickupStatus.PICKED_UP
  );
}

export function countDistinctQualifyingPassengers(
  bookings: BookingPassengerEvidence[],
): number {
  const ids = new Set<string>();
  for (const b of bookings) {
    if (isQualifyingCompletedPassenger(b)) {
      ids.add(b.passengerId);
    }
  }
  return ids.size;
}

/** Minimum distinct completed passengers for a ride to qualify. */
export const MIN_QUALIFYING_PASSENGERS = 2;
