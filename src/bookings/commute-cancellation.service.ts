import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  Repository,
} from 'typeorm';

import { AssuredRideLifecycleResponseDto } from '../assured/dto/assured-lifecycle-response.dto';
import { Ride } from '../rides/entities/ride.entity';
import {
  RideCancellationReason,
  RideStatus,
  RideType,
} from '../rides/enums/ride.enums';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletService } from '../wallet/wallet.service';
import {
  commuteRideCancelRefundKey,
  commuteRideFullRefundKey,
  commuteRiderCancelRefundKey,
} from './commute-cancellation.math';
import { CommuteAutoCancelledBookingDto } from './dto/commute-booking-action-response.dto';
import { CommuteBookingCancellationResponseDto } from './dto/commute-cancellation-response.dto';
import { Booking } from './entities/booking.entity';
import {
  BookingCancellationReason,
  BookingMode,
  BookingPaymentStatus,
  BookingStatus,
} from './enums/booking.enums';

export interface CommuteBookingCancelResult {
  booking: Booking;
  seatsRestored: number;
  fareRefunded: bigint;
  alreadyApplied: boolean;
}

@Injectable()
export class CommuteCancellationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly walletService: WalletService,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(WalletTransaction)
    private readonly walletTransactionRepository: Repository<WalletTransaction>,
  ) {}

  async cancelBookingByPassenger(
    passengerId: string,
    bookingId: string,
  ): Promise<CommuteBookingCancellationResponseDto> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const bookingPeek = await manager.getRepository(Booking).findOne({
          where: { id: bookingId },
        });
        if (!bookingPeek || bookingPeek.passengerId !== passengerId) {
          throw new NotFoundException('Booking not found');
        }

        const ride = await this.lockRideForUpdate(manager, bookingPeek.rideId);
        const booking = await this.lockBookingForUpdate(manager, bookingId);
        if (!booking) {
          throw new NotFoundException('Booking not found');
        }

        this.assertCommuteBooking(booking, ride);

        const result = await this.cancelCommuteBookingInTransaction(manager, {
          ride,
          booking,
          cancellationReason: BookingCancellationReason.RIDER_CANCELLED,
          refundIdempotencyKey: commuteRiderCancelRefundKey(booking.id),
          restoreSeats: booking.status === BookingStatus.CONFIRMED,
        });

        return this.toPassengerCancelResponse(result, ride.id);
      });
    } catch (error) {
      if (this.walletService.isIdempotencyKeyConflict(error)) {
        const recovered = await this.recoverPassengerCancelIdempotent(
          passengerId,
          bookingId,
          BookingCancellationReason.RIDER_CANCELLED,
          commuteRiderCancelRefundKey(bookingId),
        );
        if (recovered) {
          return recovered;
        }
      }
      throw error;
    }
  }

  async cancelRideByDriver(
    driverId: string,
    rideId: string,
  ): Promise<AssuredRideLifecycleResponseDto> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const ride = await this.lockRideForUpdate(manager, rideId);
        if (!ride || ride.driverId !== driverId) {
          throw new NotFoundException('Ride not found');
        }

        if (ride.rideType !== RideType.COMMUTE) {
          throw new ConflictException('Ride is not a Commute ride');
        }

        if (ride.status === RideStatus.COMPLETED) {
          throw new ConflictException('Completed rides cannot be cancelled');
        }

        if (ride.status === RideStatus.CANCELLED) {
          if (
            ride.cancellationReason === RideCancellationReason.DRIVER_CANCELLED
          ) {
            return this.toRideCancelResponse(ride, 0n, 0, true);
          }
          throw new ConflictException(
            `Ride is already cancelled (${ride.cancellationReason})`,
          );
        }

        if (ride.status !== RideStatus.PUBLISHED) {
          throw new ConflictException(
            `Ride cannot be cancelled from status ${ride.status}`,
          );
        }

        const activeBookings = await manager
          .getRepository(Booking)
          .createQueryBuilder('booking')
          .setLock('pessimistic_write')
          .where('booking.ride_id = :rideId', { rideId: ride.id })
          .andWhere('booking.status IN (:...statuses)', {
            statuses: [BookingStatus.PENDING, BookingStatus.CONFIRMED],
          })
          .orderBy('booking.created_at', 'ASC')
          .addOrderBy('booking.id', 'ASC')
          .getMany();

        let fareRefundedTotal = 0n;
        for (const booking of activeBookings) {
          const result = await this.cancelCommuteBookingInTransaction(manager, {
            ride,
            booking,
            cancellationReason: BookingCancellationReason.RIDE_CANCELLED,
            refundIdempotencyKey: commuteRideCancelRefundKey(booking.id),
            restoreSeats: false,
          });
          fareRefundedTotal += result.fareRefunded;
        }

        const now = new Date();
        ride.status = RideStatus.CANCELLED;
        ride.cancellationReason = RideCancellationReason.DRIVER_CANCELLED;
        ride.cancelledByUserId = driverId;
        ride.cancelledAt = now;
        await manager.getRepository(Ride).save(ride);

        return this.toRideCancelResponse(
          ride,
          fareRefundedTotal,
          activeBookings.length,
          false,
        );
      });
    } catch (error) {
      if (this.walletService.isIdempotencyKeyConflict(error)) {
        const ride = await this.dataSource.getRepository(Ride).findOne({
          where: { id: rideId, driverId },
        });
        if (
          ride &&
          ride.rideType === RideType.COMMUTE &&
          ride.status === RideStatus.CANCELLED &&
          ride.cancellationReason === RideCancellationReason.DRIVER_CANCELLED
        ) {
          const cancelledCount = await this.bookingRepository.count({
            where: {
              rideId,
              status: BookingStatus.CANCELLED,
              cancellationReason: BookingCancellationReason.RIDE_CANCELLED,
            },
          });
          return this.toRideCancelResponse(ride, 0n, cancelledCount, true);
        }
      }
      throw error;
    }
  }

  async autoCancelRemainingPendingWhenFull(
    manager: EntityManager,
    ride: Ride,
    excludeBookingId: string,
  ): Promise<CommuteAutoCancelledBookingDto[]> {
    if (ride.availableSeats !== 0) {
      return [];
    }

    const pendingBookings = await manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .setLock('pessimistic_write')
      .where('booking.ride_id = :rideId', { rideId: ride.id })
      .andWhere('booking.status = :status', { status: BookingStatus.PENDING })
      .andWhere('booking.id != :excludeBookingId', { excludeBookingId })
      .orderBy('booking.created_at', 'ASC')
      .addOrderBy('booking.id', 'ASC')
      .getMany();

    const autoCancelled: CommuteAutoCancelledBookingDto[] = [];

    for (const pending of pendingBookings) {
      const locked = await this.lockBookingForUpdate(manager, pending.id);
      if (!locked || locked.status !== BookingStatus.PENDING) {
        continue;
      }

      const result = await this.cancelCommuteBookingInTransaction(manager, {
        ride,
        booking: locked,
        cancellationReason: BookingCancellationReason.COMMUTE_RIDE_FULL,
        refundIdempotencyKey: commuteRideFullRefundKey(locked.id),
        restoreSeats: false,
      });

      autoCancelled.push({
        bookingId: locked.id,
        status: BookingStatus.CANCELLED,
        cancellationReason: BookingCancellationReason.COMMUTE_RIDE_FULL,
        refunded: result.fareRefunded > 0n,
      });
    }

    return autoCancelled;
  }

  async cancelCommuteBookingInTransaction(
    manager: EntityManager,
    params: {
      ride: Ride;
      booking: Booking;
      cancellationReason: BookingCancellationReason;
      refundIdempotencyKey: string;
      restoreSeats: boolean;
    },
  ): Promise<CommuteBookingCancelResult> {
    const { ride, booking, cancellationReason, refundIdempotencyKey } = params;

    if (booking.bookingMode !== BookingMode.COMMUTE) {
      throw new ConflictException('Booking is not a Commute booking');
    }

    if (booking.status === BookingStatus.CANCELLED) {
      if (booking.cancellationReason === cancellationReason) {
        return {
          booking,
          seatsRestored: 0,
          fareRefunded: 0n,
          alreadyApplied: true,
        };
      }
      throw new ConflictException(
        `Booking is already cancelled (${booking.cancellationReason})`,
      );
    }

    if (
      booking.status !== BookingStatus.PENDING &&
      booking.status !== BookingStatus.CONFIRMED
    ) {
      throw new ConflictException(
        `Booking cannot be cancelled from status ${booking.status}`,
      );
    }

    let seatsRestored = 0;
    if (params.restoreSeats && booking.status === BookingStatus.CONFIRMED) {
      seatsRestored = this.restoreCommuteSeats(ride, booking.seats);
      await manager.getRepository(Ride).save(ride);
    }

    const fareRefunded = await this.refundPaidCommuteBookingInTransaction(
      manager,
      booking,
      refundIdempotencyKey,
    );

    const now = new Date();
    booking.status = BookingStatus.CANCELLED;
    booking.cancellationReason = cancellationReason;
    booking.cancelledAt = now;
    if (fareRefunded > 0n) {
      booking.paymentStatus = BookingPaymentStatus.REFUNDED;
    }
    await manager.getRepository(Booking).save(booking);

    return {
      booking,
      seatsRestored,
      fareRefunded,
      alreadyApplied: false,
    };
  }

  private async refundPaidCommuteBookingInTransaction(
    manager: EntityManager,
    booking: Booking,
    idempotencyKey: string,
  ): Promise<bigint> {
    if (
      booking.paymentStatus !== BookingPaymentStatus.PAID ||
      BigInt(booking.totalAmount) <= 0n
    ) {
      return 0n;
    }

    const wallet = await this.lockWalletForUpdate(manager, booking.passengerId);
    await this.walletService.creditPointsInTransaction(manager, {
      walletId: wallet.id,
      userId: booking.passengerId,
      amount: BigInt(booking.totalAmount),
      sourceType: WalletPointSource.PURCHASED,
      referenceType: 'BOOKING',
      referenceId: booking.id,
      idempotencyKey,
      transactionType: WalletTransactionType.REFUND,
    });

    return BigInt(booking.totalAmount);
  }

  private restoreCommuteSeats(ride: Ride, seats: number): number {
    const before = ride.availableSeats;
    ride.availableSeats = Math.min(ride.totalSeats, ride.availableSeats + seats);
    return ride.availableSeats - before;
  }

  private assertCommuteBooking(booking: Booking, ride: Ride): void {
    if (booking.bookingMode !== BookingMode.COMMUTE) {
      throw new ConflictException('Booking is not a Commute booking');
    }
    if (ride.rideType !== RideType.COMMUTE) {
      throw new ConflictException('Ride is not a Commute ride');
    }
  }

  private async recoverPassengerCancelIdempotent(
    passengerId: string,
    bookingId: string,
    expectedReason: BookingCancellationReason,
    refundKey: string,
  ): Promise<CommuteBookingCancellationResponseDto | null> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
    });
    if (
      !booking ||
      booking.status !== BookingStatus.CANCELLED ||
      booking.cancellationReason !== expectedReason
    ) {
      return null;
    }

    const refundTx = await this.walletTransactionRepository.findOne({
      where: { idempotencyKey: refundKey },
    });

    return this.toPassengerCancelResponse(
      {
        booking,
        seatsRestored: 0,
        fareRefunded: refundTx ? BigInt(refundTx.amount) : 0n,
        alreadyApplied: true,
      },
      booking.rideId,
    );
  }

  private toPassengerCancelResponse(
    result: CommuteBookingCancelResult,
    rideId: string,
  ): CommuteBookingCancellationResponseDto {
    return {
      bookingId: result.booking.id,
      rideId,
      status: result.booking.status,
      cancellationReason: result.booking.cancellationReason,
      paymentStatus: result.booking.paymentStatus,
      seatsRestored: result.seatsRestored,
      fareRefunded: result.fareRefunded.toString(),
      alreadyApplied: result.alreadyApplied,
    };
  }

  private toRideCancelResponse(
    ride: Ride,
    fareRefundedTotal: bigint,
    cancelledBookingCount: number,
    alreadyApplied: boolean,
  ): AssuredRideLifecycleResponseDto {
    return {
      rideId: ride.id,
      status: ride.status,
      cancellationReason: ride.cancellationReason,
      cancelledBookingCount,
      driverDepositForfeited: null,
      riderCompensationTotal: '0',
      platformForfeiture: '0',
      fareRefundedTotal: fareRefundedTotal.toString(),
      couponsIssuedCount: 0,
      alreadyApplied,
    };
  }

  private async lockRideForUpdate(
    manager: EntityManager,
    rideId: string,
  ): Promise<Ride> {
    const ride = await manager
      .getRepository(Ride)
      .createQueryBuilder('ride')
      .setLock('pessimistic_write')
      .where('ride.id = :rideId', { rideId })
      .getOne();

    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    return ride;
  }

  private async lockBookingForUpdate(
    manager: EntityManager,
    bookingId: string,
  ): Promise<Booking | null> {
    return manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .setLock('pessimistic_write')
      .where('booking.id = :bookingId', { bookingId })
      .getOne();
  }

  private async lockWalletForUpdate(
    manager: EntityManager,
    userId: string,
  ): Promise<Wallet> {
    const wallet = await manager
      .getRepository(Wallet)
      .createQueryBuilder('wallet')
      .setLock('pessimistic_write')
      .where('wallet.user_id = :userId', { userId })
      .getOne();

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    return wallet;
  }
}
