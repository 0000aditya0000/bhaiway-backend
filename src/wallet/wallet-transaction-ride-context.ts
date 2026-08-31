import { In, Repository } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { Ride } from '../rides/entities/ride.entity';
import { RideType } from '../rides/enums/ride.enums';
import {
  WalletTransaction,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';

export interface WalletTransactionRideContext {
  rideId: string;
  rideType: RideType;
}

/** Matches mobile booking-transaction detection (no invented ride data). */
export function isBookingWalletTransaction(
  tx: Pick<WalletTransaction, 'transactionType' | 'referenceType'>,
): boolean {
  if (tx.referenceType === 'BOOKING') {
    return true;
  }
  return tx.transactionType === WalletTransactionType.BOOKING_PAYMENT;
}

/**
 * Resolves rideId + rideType for booking wallet rows via real Booking/Ride records.
 * Returns only entries that can be resolved from the database.
 */
export async function resolveRideContextForTransactions(
  transactions: WalletTransaction[],
  bookingRepository: Repository<Booking>,
  rideRepository: Repository<Ride>,
): Promise<Map<string, WalletTransactionRideContext>> {
  const result = new Map<string, WalletTransactionRideContext>();
  const bookingIds = new Set<string>();
  const directRideIds = new Set<string>();
  const txIdToBookingId = new Map<string, string>();
  const txIdToRideId = new Map<string, string>();

  for (const tx of transactions) {
    if (!isBookingWalletTransaction(tx) || !tx.referenceId) {
      continue;
    }

    if (tx.referenceType === 'RIDE') {
      directRideIds.add(tx.referenceId);
      txIdToRideId.set(tx.id, tx.referenceId);
      continue;
    }

    bookingIds.add(tx.referenceId);
    txIdToBookingId.set(tx.id, tx.referenceId);
  }

  const ridesById = new Map<string, Ride>();

  if (directRideIds.size > 0) {
    const rides = await rideRepository.find({
      where: { id: In([...directRideIds]) },
      select: { id: true, rideType: true },
    });
    for (const ride of rides) {
      ridesById.set(ride.id, ride);
    }
  }

  if (bookingIds.size > 0) {
    const bookings = await bookingRepository.find({
      where: { id: In([...bookingIds]) },
      select: { id: true, rideId: true },
    });
    const bookingById = new Map(bookings.map((b) => [b.id, b] as const));
    const rideIdsFromBookings = [
      ...new Set(bookings.map((booking) => booking.rideId)),
    ].filter((rideId) => !ridesById.has(rideId));

    if (rideIdsFromBookings.length > 0) {
      const rides = await rideRepository.find({
        where: { id: In(rideIdsFromBookings) },
        select: { id: true, rideType: true },
      });
      for (const ride of rides) {
        ridesById.set(ride.id, ride);
      }
    }

    for (const [txId, bookingId] of txIdToBookingId) {
      const booking = bookingById.get(bookingId);
      if (!booking) {
        continue;
      }
      const ride = ridesById.get(booking.rideId);
      if (!ride) {
        continue;
      }
      result.set(txId, { rideId: ride.id, rideType: ride.rideType });
    }
  }

  for (const [txId, rideId] of txIdToRideId) {
    const ride = ridesById.get(rideId);
    if (!ride) {
      continue;
    }
    result.set(txId, { rideId: ride.id, rideType: ride.rideType });
  }

  return result;
}
