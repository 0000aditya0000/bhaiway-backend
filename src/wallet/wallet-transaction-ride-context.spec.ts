import { Repository } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { Ride } from '../rides/entities/ride.entity';
import { RideType } from '../rides/enums/ride.enums';
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';
import {
  isBookingWalletTransaction,
  resolveRideContextForTransactions,
} from './wallet-transaction-ride-context';

function tx(
  overrides: Partial<WalletTransaction> & Pick<WalletTransaction, 'id'>,
): WalletTransaction {
  return {
    walletId: 'wallet-1',
    userId: 'user-1',
    transactionType: WalletTransactionType.BOOKING_PAYMENT,
    pointSource: null,
    direction: WalletTransactionDirection.DEBIT,
    amount: '100',
    balanceBefore: '500',
    balanceAfter: '400',
    referenceType: 'BOOKING',
    referenceId: 'booking-1',
    parentTransactionId: null,
    idempotencyKey: `key-${overrides.id}`,
    status: WalletTransactionStatus.POSTED,
    createdAt: new Date(),
    ...overrides,
  } as WalletTransaction;
}

describe('wallet-transaction-ride-context', () => {
  it('detects booking transactions by referenceType or BOOKING_PAYMENT type', () => {
    expect(
      isBookingWalletTransaction({
        transactionType: WalletTransactionType.BOOKING_PAYMENT,
        referenceType: 'BOOKING',
      }),
    ).toBe(true);
    expect(
      isBookingWalletTransaction({
        transactionType: WalletTransactionType.POINT_PURCHASE,
        referenceType: 'BOOKING',
      }),
    ).toBe(true);
    expect(
      isBookingWalletTransaction({
        transactionType: WalletTransactionType.POINT_PURCHASE,
        referenceType: null,
      }),
    ).toBe(false);
  });

  it('resolves rideId and rideType from booking reference', async () => {
    const bookingRepository = {
      find: jest.fn().mockResolvedValue([
        { id: 'booking-1', rideId: 'ride-1' },
      ]),
    } as unknown as Repository<Booking>;
    const rideRepository = {
      find: jest.fn().mockResolvedValue([
        { id: 'ride-1', rideType: RideType.ASSURED },
      ]),
    } as unknown as Repository<Ride>;

    const context = await resolveRideContextForTransactions(
      [tx({ id: 'tx-1', referenceId: 'booking-1' })],
      bookingRepository,
      rideRepository,
    );

    expect(context.get('tx-1')).toEqual({
      rideId: 'ride-1',
      rideType: RideType.ASSURED,
    });
  });

  it('resolves direct RIDE reference without booking lookup', async () => {
    const bookingRepository = {
      find: jest.fn(),
    } as unknown as Repository<Booking>;
    const rideRepository = {
      find: jest.fn().mockResolvedValue([
        { id: 'ride-2', rideType: RideType.REGULAR },
      ]),
    } as unknown as Repository<Ride>;

    const context = await resolveRideContextForTransactions(
      [
        tx({
          id: 'tx-2',
          referenceType: 'RIDE',
          referenceId: 'ride-2',
        }),
      ],
      bookingRepository,
      rideRepository,
    );

    expect(bookingRepository.find).not.toHaveBeenCalled();
    expect(context.get('tx-2')).toEqual({
      rideId: 'ride-2',
      rideType: RideType.REGULAR,
    });
  });

  it('omits unresolved booking transactions', async () => {
    const bookingRepository = {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<Booking>;
    const rideRepository = {
      find: jest.fn(),
    } as unknown as Repository<Ride>;

    const context = await resolveRideContextForTransactions(
      [tx({ id: 'tx-3', referenceId: 'missing-booking' })],
      bookingRepository,
      rideRepository,
    );

    expect(context.size).toBe(0);
  });
});
