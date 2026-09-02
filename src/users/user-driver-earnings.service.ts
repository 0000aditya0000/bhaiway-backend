import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { Ride } from '../rides/entities/ride.entity';
import { RideType } from '../rides/enums/ride.enums';
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import { pointsToCoins } from '../wallet/wallet-coins.mapper';

const DRIVER_INCOME_TRANSACTION_TYPES = [
  WalletTransactionType.DRIVER_EARNING,
  WalletTransactionType.ASSURED_PASSENGER_CANCEL_DEPOSIT_DRIVER,
  WalletTransactionType.ASSURED_PASSENGER_CANCEL_FARE_DRIVER,
  WalletTransactionType.ASSURED_PARTIAL_FILL_COMPENSATION,
] as const;

const BOOKING_REFERENCE_TYPES = [
  'BOOKING',
  'ASSURED_PASSENGER_CANCEL_DEPOSIT',
  'ASSURED_PASSENGER_CANCEL_FARE',
] as const;

const RIDE_REFERENCE_TYPES = ['ASSURED_PARTIAL_FILL_COMPENSATION'] as const;

export interface UserDriverEarningsSummary {
  regularTotalCoins: string;
  assuredTotalCoins: string;
  commuteTotalCoins: string;
  totalCoins: string;
}

@Injectable()
export class UserDriverEarningsService {
  constructor(
    @InjectRepository(WalletTransaction)
    private readonly walletTransactionRepository: Repository<WalletTransaction>,
  ) {}

  async getLifetimeEarningsByRideType(
    userId: string,
  ): Promise<UserDriverEarningsSummary> {
    const rows = await this.walletTransactionRepository
      .createQueryBuilder('tx')
      .leftJoin(
        Booking,
        'booking',
        'booking.id::text = tx.reference_id AND tx.reference_type IN (:...bookingRefTypes)',
        { bookingRefTypes: [...BOOKING_REFERENCE_TYPES] },
      )
      .leftJoin(
        Ride,
        'ride_from_booking',
        'ride_from_booking.id = booking.ride_id',
      )
      .leftJoin(
        Ride,
        'ride_direct',
        'ride_direct.id::text = tx.reference_id AND tx.reference_type IN (:...rideRefTypes)',
        { rideRefTypes: [...RIDE_REFERENCE_TYPES] },
      )
      .select(
        'COALESCE(ride_from_booking.ride_type, ride_direct.ride_type)',
        'rideType',
      )
      .addSelect('SUM(tx.amount::bigint)', 'total')
      .where('tx.user_id = :userId', { userId })
      .andWhere('tx.direction = :direction', {
        direction: WalletTransactionDirection.CREDIT,
      })
      .andWhere('tx.status = :status', {
        status: WalletTransactionStatus.POSTED,
      })
      .andWhere('tx.transaction_type IN (:...types)', {
        types: [...DRIVER_INCOME_TRANSACTION_TYPES],
      })
      .groupBy('COALESCE(ride_from_booking.ride_type, ride_direct.ride_type)')
      .getRawMany<{ rideType: RideType | null; total: string }>();

    let regular = 0n;
    let assured = 0n;
    let commute = 0n;

    for (const row of rows) {
      const amount = BigInt(row.total ?? 0);
      switch (row.rideType) {
        case RideType.REGULAR:
          regular += amount;
          break;
        case RideType.ASSURED:
          assured += amount;
          break;
        case RideType.COMMUTE:
          commute += amount;
          break;
        default:
          break;
      }
    }

    const total = regular + assured + commute;

    return {
      regularTotalCoins: pointsToCoins(regular),
      assuredTotalCoins: pointsToCoins(assured),
      commuteTotalCoins: pointsToCoins(commute),
      totalCoins: pointsToCoins(total),
    };
  }
}
