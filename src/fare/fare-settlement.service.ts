import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
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
import { RideStatus } from '../rides/enums/ride.enums';
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

export interface RegularPayLaterSettlementResult {
  bookingId: string;
  fareAmount: string;
  paymentStatus: BookingPaymentStatus;
  passengerDebited: string;
  driverCredited: string;
  paymentChannel: 'WALLET' | 'CASH';
  alreadySettled: boolean;
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
      if (this.bookingNeedsWalletAtRideCompletion(booking)) {
        userIds.add(booking.passengerId);
      }
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
      if (this.bookingNeedsWalletAtRideCompletion(booking) && !passengerWallet) {
        throw new WalletNotFoundError();
      }

      const result = await this.settleBookingFareInTransaction(manager, {
        booking,
        ride: params.ride,
        driverWallet,
        passengerWallet: passengerWallet ?? null,
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
      passengerWallet: Wallet | null;
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

    if (this.isDeferredRegularPayLater(booking)) {
      return {
        bookingId: booking.id,
        fareAmount: booking.totalAmount,
        passengerDebited: '0',
        driverCredited: '0',
        alreadySettled: false,
      };
    }

    this.assertFareSettlementAllowed(booking);

    let passengerDebited = 0n;

    if (this.requiresPassengerFareDebit(booking)) {
      if (!passengerWallet) {
        throw new WalletNotFoundError();
      }
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
      }

      booking.paymentStatus = BookingPaymentStatus.PAID;
      await manager.getRepository(Booking).save(booking);
    } else if (booking.paymentMethod === BookingPaymentMethod.PAY_NOW) {
      this.assertPayNowBookingPaymentRecorded(booking, fareAmount);
    }

    let driverCredited = 0n;
    if (this.shouldCreditDriverAtRideCompletion(booking) && fareAmount > 0n) {
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

  async settleRegularPayLaterWithWalletInTransaction(
    manager: EntityManager,
    passengerId: string,
    bookingId: string,
  ): Promise<RegularPayLaterSettlementResult> {
    const booking = await manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .setLock('pessimistic_write')
      .where('booking.id = :bookingId', { bookingId })
      .getOne();

    if (!booking || booking.passengerId !== passengerId) {
      throw new NotFoundException('Booking not found');
    }

    const ride = await manager
      .getRepository(Ride)
      .createQueryBuilder('ride')
      .setLock('pessimistic_write')
      .where('ride.id = :rideId', { rideId: booking.rideId })
      .getOne();

    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    this.assertRegularPayLaterSettlementEligible(booking, ride);

    const fareAmount = parseFareAmount(booking.totalAmount);
    const driverCreditKey = fareSettlementDriverCreditKey(booking.id);
    const debitKey = fareSettlementPassengerDebitKey(booking.id);

    const existingDriverCredit = await manager
      .getRepository(WalletTransaction)
      .findOne({ where: { idempotencyKey: driverCreditKey } });

    if (booking.paymentStatus === BookingPaymentStatus.PAID) {
      if (booking.walletTransactionId || existingDriverCredit) {
        return {
          bookingId: booking.id,
          fareAmount: booking.totalAmount,
          paymentStatus: BookingPaymentStatus.PAID,
          passengerDebited: fareAmount.toString(),
          driverCredited: existingDriverCredit?.amount ?? fareAmount.toString(),
          paymentChannel: 'WALLET',
          alreadySettled: true,
        };
      }
      throw new ConflictException('Fare already paid via cash');
    }

    const walletByUserId = await this.lockWalletsByUserIds(
      manager,
      new Set([passengerId, ride.driverId]),
    );
    const passengerWallet = walletByUserId.get(passengerId);
    const driverWallet = walletByUserId.get(ride.driverId);
    if (!passengerWallet || !driverWallet) {
      throw new WalletNotFoundError();
    }

    this.assertWalletAllowsPayment(passengerWallet);

    let passengerDebited = 0n;
    if (fareAmount > 0n) {
      await this.walletService.debitPointsInTransaction(manager, {
        walletId: passengerWallet.id,
        userId: passengerId,
        amount: fareAmount,
        referenceType: 'BOOKING',
        referenceId: booking.id,
        idempotencyKey: debitKey,
        transactionType: WalletTransactionType.BOOKING_PAYMENT,
      });
      passengerDebited = fareAmount;

      const debitTx = await manager
        .getRepository(WalletTransaction)
        .findOneOrFail({ where: { idempotencyKey: debitKey } });
      booking.walletTransactionId = debitTx.id;
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

    booking.paymentStatus = BookingPaymentStatus.PAID;
    await manager.getRepository(Booking).save(booking);

    return {
      bookingId: booking.id,
      fareAmount: booking.totalAmount,
      paymentStatus: BookingPaymentStatus.PAID,
      passengerDebited: passengerDebited.toString(),
      driverCredited: driverCredited.toString(),
      paymentChannel: 'WALLET',
      alreadySettled: false,
    };
  }

  async settleRegularPayLaterWithCashInTransaction(
    manager: EntityManager,
    passengerId: string,
    bookingId: string,
  ): Promise<RegularPayLaterSettlementResult> {
    const booking = await manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .setLock('pessimistic_write')
      .where('booking.id = :bookingId', { bookingId })
      .getOne();

    if (!booking || booking.passengerId !== passengerId) {
      throw new NotFoundException('Booking not found');
    }

    const ride = await manager
      .getRepository(Ride)
      .findOne({ where: { id: booking.rideId } });

    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    this.assertRegularPayLaterSettlementEligible(booking, ride);

    if (booking.paymentStatus === BookingPaymentStatus.PAID) {
      if (booking.walletTransactionId) {
        throw new ConflictException('Fare already paid via wallet');
      }
      return {
        bookingId: booking.id,
        fareAmount: booking.totalAmount,
        paymentStatus: BookingPaymentStatus.PAID,
        passengerDebited: '0',
        driverCredited: '0',
        paymentChannel: 'CASH',
        alreadySettled: true,
      };
    }

    booking.paymentStatus = BookingPaymentStatus.PAID;
    await manager.getRepository(Booking).save(booking);

    return {
      bookingId: booking.id,
      fareAmount: booking.totalAmount,
      paymentStatus: BookingPaymentStatus.PAID,
      passengerDebited: '0',
      driverCredited: '0',
      paymentChannel: 'CASH',
      alreadySettled: false,
    };
  }

  /**
   * REGULAR PAY_LATER bookings keep fare UNPAID until the passenger explicitly
   * pays via wallet or cash after ride completion.
   */
  private isDeferredRegularPayLater(booking: Booking): boolean {
    return (
      booking.bookingMode === BookingMode.REGULAR &&
      booking.paymentMethod === BookingPaymentMethod.PAY_LATER &&
      booking.paymentStatus === BookingPaymentStatus.UNPAID
    );
  }

  private bookingNeedsWalletAtRideCompletion(booking: Booking): boolean {
    if (this.isDeferredRegularPayLater(booking)) {
      return false;
    }
    return (
      this.requiresPassengerFareDebit(booking) ||
      this.shouldCreditDriverAtRideCompletion(booking)
    );
  }

  private shouldCreditDriverAtRideCompletion(booking: Booking): boolean {
    if (this.isDeferredRegularPayLater(booking)) {
      return false;
    }
    return parseFareAmount(booking.totalAmount) > 0n;
  }

  private requiresPassengerFareDebit(booking: Booking): boolean {
    if (booking.paymentStatus === BookingPaymentStatus.PAID) {
      return false;
    }

    switch (booking.paymentMethod) {
      case BookingPaymentMethod.PAY_LATER:
        return !this.isDeferredRegularPayLater(booking);
      case BookingPaymentMethod.ASSURED_DEPOSIT:
        return booking.bookingMode === BookingMode.ASSURED;
      case BookingPaymentMethod.PAY_NOW:
        return false;
      default:
        return false;
    }
  }

  private assertRegularPayLaterSettlementEligible(
    booking: Booking,
    ride: Ride,
  ): void {
    if (
      booking.bookingMode !== BookingMode.REGULAR ||
      booking.paymentMethod !== BookingPaymentMethod.PAY_LATER
    ) {
      throw new BadRequestException(
        'Payment applies only to REGULAR PAY_LATER bookings',
      );
    }
    if (booking.status !== BookingStatus.COMPLETED) {
      throw new ConflictException('Ride must be completed before fare payment');
    }
    if (ride.status !== RideStatus.COMPLETED) {
      throw new ConflictException('Ride must be completed before fare payment');
    }
  }

  private assertFareSettlementAllowed(booking: Booking): void {
    if (booking.bookingMode === BookingMode.COMMUTE) {
      throw new BadRequestException(
        'Commute bookings are settled at Commute ride completion, not via regular fare settlement',
      );
    }

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
