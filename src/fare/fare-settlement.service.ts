import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingMode,
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { Ride } from '../rides/entities/ride.entity';
import { Wallet, WalletStatus } from '../wallet/entities/wallet.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import { WalletNotFoundError } from '../wallet/errors/wallet.errors';
import { WalletService } from '../wallet/wallet.service';
import {
  fareSettlementDriverCreditKey,
  fareSettlementPassengerDebitKey,
  parseFareAmount,
} from './fare-settlement.math';

export interface BookingFareSettlementResult {
  bookingId: string;
  fareAmount: string;
  passengerDebited: string;
  driverCredited: string;
  alreadySettled: boolean;
}

export interface RideFareSettlementSummary {
  bookings: BookingFareSettlementResult[];
  totalDriverCredited: string;
}

@Injectable()
export class FareSettlementService {
  constructor(private readonly walletService: WalletService) {}

  /**
   * Settle fare for all active bookings on a ride within an existing transaction.
   * Lock order: Wallet rows (sorted by wallet id) before wallet balance/lot locks
   * inside WalletService — consistent with booking payment flows.
   */
  async settleRideFaresInTransaction(
    manager: EntityManager,
    params: {
      ride: Ride;
      driverId: string;
      bookings: Booking[];
    },
  ): Promise<RideFareSettlementSummary> {
    const toSettle = params.bookings
      .filter(
        (booking) =>
          booking.status === BookingStatus.PENDING ||
          booking.status === BookingStatus.CONFIRMED,
      )
      .sort((a, b) => a.id.localeCompare(b.id));

    if (toSettle.length === 0) {
      return { bookings: [], totalDriverCredited: '0' };
    }

    const userIds = new Set<string>([params.driverId]);
    for (const booking of toSettle) {
      userIds.add(booking.passengerId);
    }

    const walletByUserId = await this.lockWalletsByUserIds(manager, userIds);
    const driverWallet = walletByUserId.get(params.driverId);
    if (!driverWallet) {
      throw new WalletNotFoundError();
    }

    const results: BookingFareSettlementResult[] = [];
    let totalDriverCredited = 0n;

    for (const booking of toSettle) {
      const passengerWallet = walletByUserId.get(booking.passengerId);
      if (!passengerWallet) {
        throw new WalletNotFoundError();
      }

      const result = await this.settleBookingFareInTransaction(manager, {
        booking,
        ride: params.ride,
        driverWallet,
        passengerWallet,
      });
      results.push(result);
      totalDriverCredited += BigInt(result.driverCredited);
    }

    return {
      bookings: results,
      totalDriverCredited: totalDriverCredited.toString(),
    };
  }

  async settleBookingFareInTransaction(
    manager: EntityManager,
    params: {
      booking: Booking;
      ride: Ride;
      driverWallet: Wallet;
      passengerWallet: Wallet;
    },
  ): Promise<BookingFareSettlementResult> {
    const { booking, ride, driverWallet, passengerWallet } = params;
    const fareAmount = parseFareAmount(booking.totalAmount);
    const driverCreditKey = fareSettlementDriverCreditKey(booking.id);

    const existingDriverCredit = await manager
      .getRepository(WalletTransaction)
      .findOne({ where: { idempotencyKey: driverCreditKey } });

    if (existingDriverCredit) {
      return {
        bookingId: booking.id,
        fareAmount: booking.totalAmount,
        passengerDebited: '0',
        driverCredited: existingDriverCredit.amount,
        alreadySettled: true,
      };
    }

    this.assertFareSettlementAllowed(booking);

    let passengerDebited = 0n;

    if (this.requiresPassengerFareDebit(booking)) {
      this.assertWalletAllowsPayment(passengerWallet);

      if (fareAmount > 0n) {
        const debitKey = fareSettlementPassengerDebitKey(booking.id);
        await this.walletService.debitPointsInTransaction(manager, {
          walletId: passengerWallet.id,
          userId: booking.passengerId,
          amount: fareAmount,
          referenceType: 'BOOKING',
          referenceId: booking.id,
          idempotencyKey: debitKey,
          transactionType: WalletTransactionType.BOOKING_PAYMENT,
        });
        passengerDebited = fareAmount;

        if (
          booking.paymentMethod === BookingPaymentMethod.PAY_LATER &&
          !booking.walletTransactionId
        ) {
          const debitTx = await manager
            .getRepository(WalletTransaction)
            .findOneOrFail({ where: { idempotencyKey: debitKey } });
          booking.walletTransactionId = debitTx.id;
        }
      }

      booking.paymentStatus = BookingPaymentStatus.PAID;
      await manager.getRepository(Booking).save(booking);
    } else if (booking.paymentMethod === BookingPaymentMethod.PAY_NOW) {
      this.assertPayNowBookingPaymentRecorded(booking, fareAmount);
    }

    let driverCredited = 0n;
    if (fareAmount > 0n) {
      await this.walletService.creditPointsInTransaction(manager, {
        walletId: driverWallet.id,
        userId: ride.driverId,
        amount: fareAmount,
        sourceType: WalletPointSource.DRIVER_EARNED,
        referenceType: 'BOOKING',
        referenceId: booking.id,
        idempotencyKey: driverCreditKey,
        transactionType: WalletTransactionType.DRIVER_EARNING,
      });
      driverCredited = fareAmount;
    }

    return {
      bookingId: booking.id,
      fareAmount: booking.totalAmount,
      passengerDebited: passengerDebited.toString(),
      driverCredited: driverCredited.toString(),
      alreadySettled: false,
    };
  }

  private requiresPassengerFareDebit(booking: Booking): boolean {
    if (booking.paymentStatus === BookingPaymentStatus.PAID) {
      return false;
    }

    switch (booking.paymentMethod) {
      case BookingPaymentMethod.PAY_LATER:
        return true;
      case BookingPaymentMethod.ASSURED_DEPOSIT:
        return booking.bookingMode === BookingMode.ASSURED;
      case BookingPaymentMethod.PAY_NOW:
        return false;
      default:
        return false;
    }
  }

  private assertFareSettlementAllowed(booking: Booking): void {
    if (booking.paymentMethod === BookingPaymentMethod.ASSURED_DEPOSIT) {
      if (booking.bookingMode !== BookingMode.ASSURED) {
        throw new BadRequestException(
          'ASSURED_DEPOSIT fare settlement applies only to Assured-mode bookings',
        );
      }
      return;
    }

    if (
      booking.paymentMethod === BookingPaymentMethod.PAY_NOW ||
      booking.paymentMethod === BookingPaymentMethod.PAY_LATER
    ) {
      return;
    }

    throw new BadRequestException(
      `Unsupported payment method for fare settlement: ${booking.paymentMethod}`,
    );
  }

  private assertPayNowBookingPaymentRecorded(
    booking: Booking,
    fareAmount: bigint,
  ): void {
    if (fareAmount === 0n) {
      return;
    }
    if (!booking.walletTransactionId) {
      throw new BadRequestException(
        `PAY_NOW booking ${booking.id} is missing the original BOOKING_PAYMENT ledger row`,
      );
    }
  }

  private assertWalletAllowsPayment(wallet: Wallet): void {
    if (wallet.status === WalletStatus.SUSPENDED) {
      throw new ForbiddenException('Wallet is suspended');
    }
    if (wallet.status === WalletStatus.LOCKED) {
      throw new ForbiddenException('Wallet is locked');
    }
  }

  private async lockWalletsByUserIds(
    manager: EntityManager,
    userIds: Set<string>,
  ): Promise<Map<string, Wallet>> {
    const sortedUserIds = [...userIds].sort();
    const walletByUserId = new Map<string, Wallet>();

    for (const userId of sortedUserIds) {
      const wallet = await manager
        .getRepository(Wallet)
        .createQueryBuilder('wallet')
        .setLock('pessimistic_write')
        .where('wallet.user_id = :userId', { userId })
        .getOne();

      if (!wallet) {
        throw new WalletNotFoundError();
      }
      walletByUserId.set(userId, wallet);
    }

    return walletByUserId;
  }
}
