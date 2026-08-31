import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingMode,
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { Ride } from '../rides/entities/ride.entity';
import { RideType } from '../rides/enums/ride.enums';
import { Wallet, WalletStatus } from '../wallet/entities/wallet.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import { WalletNotFoundError } from '../wallet/errors/wallet.errors';
import {
  PLATFORM_USER_ID,
  PLATFORM_WALLET_ID,
} from '../wallet/platform-wallet.constants';
import { WalletService } from '../wallet/wallet.service';
import {
  commuteSettlementDriverCreditKey,
  commuteSettlementPlatformMarginKey,
} from './commute-settlement.math';

export interface CommuteBookingSettlementResult {
  bookingId: string;
  driverCredited: string;
  platformCredited: string;
  alreadySettled: boolean;
}

export interface CommuteRideSettlementSummary {
  settledBookingCount: number;
  driverSettlementTotal: string;
  platformMarginTotal: string;
}

@Injectable()
export class CommuteSettlementService {
  constructor(private readonly walletService: WalletService) {}

  async settleCommuteRideInTransaction(
    manager: EntityManager,
    params: {
      ride: Ride;
      driverId: string;
      bookings: Booking[];
    },
  ): Promise<CommuteRideSettlementSummary> {
    if (params.ride.rideType !== RideType.COMMUTE) {
      throw new BadRequestException('Ride is not a Commute ride');
    }

    const toSettle = params.bookings
      .filter(
        (booking) =>
          booking.bookingMode === BookingMode.COMMUTE &&
          booking.status === BookingStatus.CONFIRMED,
      )
      .sort((a, b) => a.id.localeCompare(b.id));

    const driverWallet = await this.lockDriverWallet(manager, params.driverId);

    const results: CommuteBookingSettlementResult[] = [];
    let driverSettlementTotal = 0n;
    let platformMarginTotal = 0n;

    for (const booking of toSettle) {
      const result = await this.settleCommuteBookingInTransaction(manager, {
        booking,
        ride: params.ride,
        driverWallet,
      });
      results.push(result);
      driverSettlementTotal += BigInt(result.driverCredited);
      platformMarginTotal += BigInt(result.platformCredited);
    }

    return {
      settledBookingCount: results.length,
      driverSettlementTotal: driverSettlementTotal.toString(),
      platformMarginTotal: platformMarginTotal.toString(),
    };
  }

  private async settleCommuteBookingInTransaction(
    manager: EntityManager,
    params: {
      booking: Booking;
      ride: Ride;
      driverWallet: Wallet;
    },
  ): Promise<CommuteBookingSettlementResult> {
    const { booking, ride, driverWallet } = params;
    const driverKey = commuteSettlementDriverCreditKey(booking.id);
    const platformKey = commuteSettlementPlatformMarginKey(booking.id);

    const [existingDriverCredit, existingPlatformCredit] = await Promise.all([
      manager.getRepository(WalletTransaction).findOne({
        where: { idempotencyKey: driverKey },
      }),
      manager.getRepository(WalletTransaction).findOne({
        where: { idempotencyKey: platformKey },
      }),
    ]);

    if (existingDriverCredit && existingPlatformCredit) {
      return {
        bookingId: booking.id,
        driverCredited: existingDriverCredit.amount,
        platformCredited: existingPlatformCredit.amount,
        alreadySettled: true,
      };
    }

    if (existingDriverCredit || existingPlatformCredit) {
      throw new BadRequestException(
        `Partial Commute settlement detected for booking ${booking.id}`,
      );
    }

    if (booking.bookingMode !== BookingMode.COMMUTE) {
      throw new BadRequestException(
        'Only Commute-mode bookings can be settled via commute settlement',
      );
    }

    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException(
        `Commute booking ${booking.id} must be CONFIRMED to settle (status=${booking.status})`,
      );
    }

    if (booking.paymentStatus !== BookingPaymentStatus.PAID) {
      throw new BadRequestException(
        `Commute booking ${booking.id} must be PAID before settlement`,
      );
    }

    if (
      booking.driverShareAmount == null ||
      booking.platformShareAmount == null
    ) {
      throw new BadRequestException(
        `Commute booking ${booking.id} is missing fare settlement snapshots`,
      );
    }

    const driverShare = BigInt(booking.driverShareAmount);
    const platformShare = BigInt(booking.platformShareAmount);

    if (driverShare + platformShare !== BigInt(booking.totalAmount)) {
      throw new BadRequestException(
        `Commute booking ${booking.id} snapshot totals are inconsistent`,
      );
    }

    if (driverShare > 0n) {
      await this.walletService.creditPointsInTransaction(manager, {
        walletId: driverWallet.id,
        userId: ride.driverId,
        amount: driverShare,
        sourceType: WalletPointSource.DRIVER_EARNED,
        referenceType: 'BOOKING',
        referenceId: booking.id,
        idempotencyKey: driverKey,
        transactionType: WalletTransactionType.DRIVER_EARNING,
      });
    }

    if (platformShare > 0n) {
      await this.walletService.creditPointsInTransaction(manager, {
        walletId: PLATFORM_WALLET_ID,
        userId: PLATFORM_USER_ID,
        amount: platformShare,
        sourceType: WalletPointSource.PURCHASED,
        referenceType: 'BOOKING',
        referenceId: booking.id,
        idempotencyKey: platformKey,
        transactionType: WalletTransactionType.COMMUTE_PLATFORM_MARGIN,
        allowPlatformOperations: true,
      });
    }

    booking.settledAt = new Date();
    await manager.getRepository(Booking).save(booking);

    return {
      bookingId: booking.id,
      driverCredited: driverShare.toString(),
      platformCredited: platformShare.toString(),
      alreadySettled: false,
    };
  }

  private async lockDriverWallet(
    manager: EntityManager,
    driverId: string,
  ): Promise<Wallet> {
    const wallet = await manager
      .getRepository(Wallet)
      .createQueryBuilder('wallet')
      .setLock('pessimistic_write')
      .where('wallet.user_id = :userId', { userId: driverId })
      .getOne();

    if (!wallet) {
      throw new WalletNotFoundError();
    }

    if (wallet.status === WalletStatus.SUSPENDED) {
      throw new BadRequestException('Driver wallet is suspended');
    }
    if (wallet.status === WalletStatus.LOCKED) {
      throw new BadRequestException('Driver wallet is locked');
    }

    return wallet;
  }
}
