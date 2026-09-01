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
  BookingFarePayment,
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

export interface PayLaterSettlementResult {
  bookingId: string;
  fareAmount: string;
  paymentStatus: BookingPaymentStatus;
  passengerDebited: string;
  driverCredited: string;
  paymentChannel: 'WALLET' | 'CASH';
  alreadySettled: boolean;
  transactionId?: string | null;
  paidAt?: string | null;
}

/** @deprecated Use PayLaterSettlementResult */
export type RegularPayLaterSettlementResult = PayLaterSettlementResult;

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

    if (this.isDeferredPayLater(booking)) {
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

  async settlePayLaterWithWalletInTransaction(
    manager: EntityManager,
    passengerId: string,
    bookingId: string,
  ): Promise<PayLaterSettlementResult> {
    return this.settleRegularPayLaterWithWalletInTransaction(
      manager,
      passengerId,
      bookingId,
    );
  }

  async settleRegularPayLaterWithWalletInTransaction(
    manager: EntityManager,
    passengerId: string,
    bookingId: string,
  ): Promise<PayLaterSettlementResult> {
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

    this.assertPayLaterSettlementEligible(booking, ride);

    const fareAmount = parseFareAmount(booking.totalAmount);
    const driverCreditKey = fareSettlementDriverCreditKey(booking.id);
    const debitKey = fareSettlementPassengerDebitKey(booking.id);

    const existingDriverCredit = await manager
      .getRepository(WalletTransaction)
      .findOne({ where: { idempotencyKey: driverCreditKey } });

    if (booking.paymentStatus === BookingPaymentStatus.PAID) {
      if (existingDriverCredit) {
        const debitTx = await manager.getRepository(WalletTransaction).findOne({
          where: { idempotencyKey: debitKey },
        });
        return {
          bookingId: booking.id,
          fareAmount: booking.totalAmount,
          paymentStatus: BookingPaymentStatus.PAID,
          passengerDebited: existingDriverCredit.amount,
          driverCredited: existingDriverCredit.amount,
          paymentChannel: 'WALLET',
          alreadySettled: true,
          transactionId: debitTx?.id ?? null,
          paidAt:
            debitTx?.createdAt.toISOString() ??
            existingDriverCredit.createdAt.toISOString(),
        };
      }
      if (this.isFarePaidAtBookingTime(booking)) {
        throw new BadRequestException('Fare was paid at booking time');
      }
      throw new ConflictException('Fare already paid via cash');
    }

    if (fareAmount === 0n) {
      booking.paymentStatus = BookingPaymentStatus.PAID;
      await manager.getRepository(Booking).save(booking);
      return {
        bookingId: booking.id,
        fareAmount: booking.totalAmount,
        paymentStatus: BookingPaymentStatus.PAID,
        passengerDebited: '0',
        driverCredited: '0',
        paymentChannel: 'WALLET',
        alreadySettled: false,
        transactionId: null,
        paidAt: new Date().toISOString(),
      };
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
      if (booking.bookingMode === BookingMode.ASSURED) {
        booking.fareWalletTransactionId = debitTx.id;
      } else {
        booking.walletTransactionId = debitTx.id;
      }
    }

    let driverCredited = 0n;
    let driverCreditTx: WalletTransaction | null = null;
    if (fareAmount > 0n) {
      const creditResult = await this.walletService.creditPointsInTransaction(
        manager,
        {
          walletId: driverWallet.id,
          userId: ride.driverId,
          amount: fareAmount,
          sourceType: WalletPointSource.DRIVER_EARNED,
          referenceType: 'BOOKING',
          referenceId: booking.id,
          idempotencyKey: driverCreditKey,
          transactionType: WalletTransactionType.DRIVER_EARNING,
        },
      );
      driverCredited = fareAmount;
      driverCreditTx = creditResult.transaction;
    }

    const paidAt = new Date();
    booking.paymentStatus = BookingPaymentStatus.PAID;
    await manager.getRepository(Booking).save(booking);

    const debitTx = await manager.getRepository(WalletTransaction).findOne({
      where: { idempotencyKey: debitKey },
    });

    return {
      bookingId: booking.id,
      fareAmount: booking.totalAmount,
      paymentStatus: BookingPaymentStatus.PAID,
      passengerDebited: passengerDebited.toString(),
      driverCredited: driverCredited.toString(),
      paymentChannel: 'WALLET',
      alreadySettled: false,
      transactionId: debitTx?.id ?? driverCreditTx?.id ?? null,
      paidAt: paidAt.toISOString(),
    };
  }

  async settlePayLaterWithCashInTransaction(
    manager: EntityManager,
    passengerId: string,
    bookingId: string,
  ): Promise<PayLaterSettlementResult> {
    return this.settleRegularPayLaterWithCashInTransaction(
      manager,
      passengerId,
      bookingId,
    );
  }

  async settleRegularPayLaterWithCashInTransaction(
    manager: EntityManager,
    passengerId: string,
    bookingId: string,
  ): Promise<PayLaterSettlementResult> {
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

    this.assertPayLaterSettlementEligible(booking, ride);

    const fareAmount = parseFareAmount(booking.totalAmount);
    const driverCreditKey = fareSettlementDriverCreditKey(booking.id);
    const existingDriverCredit = await manager
      .getRepository(WalletTransaction)
      .findOne({ where: { idempotencyKey: driverCreditKey } });

    if (booking.paymentStatus === BookingPaymentStatus.PAID) {
      if (existingDriverCredit) {
        throw new ConflictException('Fare already paid via wallet');
      }
      if (this.isFarePaidAtBookingTime(booking)) {
        throw new BadRequestException('Fare was paid at booking time');
      }
      return {
        bookingId: booking.id,
        fareAmount: booking.totalAmount,
        paymentStatus: BookingPaymentStatus.PAID,
        passengerDebited: '0',
        driverCredited: '0',
        paymentChannel: 'CASH',
        alreadySettled: true,
        transactionId: null,
        paidAt: booking.updatedAt.toISOString(),
      };
    }

    const paidAt = new Date();
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
      transactionId: null,
      paidAt: paidAt.toISOString(),
    };
  }

  /**
   * REGULAR or ASSURED PAY_LATER bookings keep fare UNPAID until the passenger
   * explicitly pays via wallet or cash after ride completion.
   */
  private isDeferredPayLater(booking: Booking): boolean {
    if (booking.paymentStatus !== BookingPaymentStatus.UNPAID) {
      return false;
    }

    if (
      booking.bookingMode === BookingMode.REGULAR &&
      booking.paymentMethod === BookingPaymentMethod.PAY_LATER
    ) {
      return true;
    }

    return this.isAssuredPayLaterFare(booking);
  }

  private isAssuredPayLaterFare(booking: Booking): boolean {
    return (
      booking.bookingMode === BookingMode.ASSURED &&
      booking.paymentMethod === BookingPaymentMethod.ASSURED_DEPOSIT &&
      (booking.farePaymentMethod === null ||
        booking.farePaymentMethod === BookingFarePayment.PAY_LATER)
    );
  }

  private isFarePaidAtBookingTime(booking: Booking): boolean {
    if (booking.paymentMethod === BookingPaymentMethod.PAY_NOW) {
      return true;
    }
    return (
      booking.bookingMode === BookingMode.ASSURED &&
      booking.paymentMethod === BookingPaymentMethod.ASSURED_DEPOSIT &&
      booking.farePaymentMethod === BookingFarePayment.PAY_NOW
    );
  }

  private bookingNeedsWalletAtRideCompletion(booking: Booking): boolean {
    if (this.isDeferredPayLater(booking)) {
      return false;
    }
    return (
      this.requiresPassengerFareDebit(booking) ||
      this.shouldCreditDriverAtRideCompletion(booking)
    );
  }

  private shouldCreditDriverAtRideCompletion(booking: Booking): boolean {
    if (this.isDeferredPayLater(booking)) {
      return false;
    }
    return parseFareAmount(booking.totalAmount) > 0n;
  }

  private requiresPassengerFareDebit(booking: Booking): boolean {
    if (booking.paymentStatus === BookingPaymentStatus.PAID) {
      return false;
    }

    if (this.isDeferredPayLater(booking)) {
      return false;
    }

    switch (booking.paymentMethod) {
      case BookingPaymentMethod.PAY_LATER:
        return false;
      case BookingPaymentMethod.ASSURED_DEPOSIT:
        return false;
      case BookingPaymentMethod.PAY_NOW:
        return false;
      default:
        return false;
    }
  }

  private assertPayLaterSettlementEligible(
    booking: Booking,
    ride: Ride,
  ): void {
    if (booking.bookingMode === BookingMode.COMMUTE) {
      throw new BadRequestException(
        'Commute bookings cannot use post-ride PAY_LATER settlement',
      );
    }

    const eligible =
      (booking.bookingMode === BookingMode.REGULAR &&
        booking.paymentMethod === BookingPaymentMethod.PAY_LATER) ||
      this.isAssuredPayLaterFare(booking);

    if (!eligible) {
      throw new BadRequestException(
        'Payment applies only to REGULAR or ASSURED PAY_LATER bookings',
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
