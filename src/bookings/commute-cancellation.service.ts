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
import { ChatService } from '../chat/chat.service';
import { NotificationsService } from '../notifications/notifications.service';
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
  commuteDriverNoShowRefundKey,
  commutePassengerNoShowRefundKey,
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
    private readonly chatService: ChatService,
    private readonly notificationsService: NotificationsService,
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
      const result = await this.dataSource.transaction(async (manager) => {
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

        const cancelResult = await this.cancelCommuteBookingInTransaction(
          manager,
          {
            ride,
            booking,
            cancellationReason: BookingCancellationReason.RIDER_CANCELLED,
            refundIdempotencyKey: commuteRiderCancelRefundKey(booking.id),
            restoreSeats: booking.status === BookingStatus.CONFIRMED,
          },
        );

        return this.toPassengerCancelResponse(cancelResult, ride.id);
      });
      await this.chatService.safeCloseForBooking(bookingId);
      const booking = await this.bookingRepository.findOne({
        where: { id: bookingId },
      });
      if (booking) {
        await this.notifyPassengerCancelledDriver(booking);
      }
      return result;
    } catch (error) {
      if (this.walletService.isIdempotencyKeyConflict(error)) {
        const recovered = await this.recoverPassengerCancelIdempotent(
          passengerId,
          bookingId,
          BookingCancellationReason.RIDER_CANCELLED,
          commuteRiderCancelRefundKey(bookingId),
        );
        if (recovered) {
          await this.chatService.safeCloseForBooking(bookingId);
          const booking = await this.bookingRepository.findOne({
            where: { id: bookingId },
          });
          if (booking) {
            await this.notifyPassengerCancelledDriver(booking);
          }
          return recovered;
        }
      }
      throw error;
    }
  }

  async settleDriverNoShowInTransaction(
    manager: EntityManager,
    params: { rideId: string; cancelledByUserId: string },
  ): Promise<{
    response: AssuredRideLifecycleResponseDto;
    cancelledForNotify: Array<{ bookingId: string; passengerId: string }>;
  }> {
    return this.cancelRideInTransaction(manager, {
      rideId: params.rideId,
      cancelledByUserId: params.cancelledByUserId,
      requireDriverOwnership: false,
      rideCancellationReason: RideCancellationReason.DRIVER_NO_SHOW,
      bookingCancellationReason: BookingCancellationReason.DRIVER_NO_SHOW,
      refundKeyForBooking: commuteDriverNoShowRefundKey,
    });
  }

  async settlePassengerNoShowInTransaction(
    manager: EntityManager,
    params: { bookingId: string; driverId: string },
  ): Promise<CommuteBookingCancelResult> {
    const bookingPeek = await manager.getRepository(Booking).findOne({
      where: { id: params.bookingId },
    });
    if (!bookingPeek) {
      throw new NotFoundException('Booking not found');
    }

    const ride = await this.lockRideForUpdate(manager, bookingPeek.rideId);
    if (ride.driverId !== params.driverId) {
      throw new NotFoundException('Booking not found');
    }

    const booking = await this.lockBookingForUpdate(manager, params.bookingId);
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    this.assertCommuteBooking(booking, ride);

    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new ConflictException(
        'Passenger no-show requires a CONFIRMED Commute booking',
      );
    }

    return this.cancelCommuteBookingInTransaction(manager, {
      ride,
      booking,
      cancellationReason: BookingCancellationReason.RIDER_NO_SHOW,
      refundIdempotencyKey: commutePassengerNoShowRefundKey(booking.id),
      restoreSeats: true,
    });
  }

  async cancelRideByDriver(
    driverId: string,
    rideId: string,
  ): Promise<AssuredRideLifecycleResponseDto> {
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        return this.cancelRideInTransaction(manager, {
          rideId,
          cancelledByUserId: driverId,
          requireDriverOwnership: true,
          rideCancellationReason: RideCancellationReason.DRIVER_CANCELLED,
          bookingCancellationReason: BookingCancellationReason.RIDE_CANCELLED,
          refundKeyForBooking: commuteRideCancelRefundKey,
        });
      });
      await this.chatService.safeCloseForRide(rideId);
      await this.notifyRideCancelledPassengers(rideId, result.cancelledForNotify);
      return result.response;
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
          const cancelled = await this.bookingRepository.find({
            where: {
              rideId,
              status: BookingStatus.CANCELLED,
              cancellationReason: BookingCancellationReason.RIDE_CANCELLED,
            },
            select: { id: true, passengerId: true },
          });
          await this.chatService.safeCloseForRide(rideId);
          await this.notifyRideCancelledPassengers(
            rideId,
            cancelled.map((booking) => ({
              bookingId: booking.id,
              passengerId: booking.passengerId,
            })),
          );
          return this.toRideCancelResponse(ride, 0n, cancelled.length, true);
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

  async cancelRideInTransaction(
    manager: EntityManager,
    params: {
      rideId: string;
      cancelledByUserId: string;
      requireDriverOwnership: boolean;
      rideCancellationReason: RideCancellationReason;
      bookingCancellationReason: BookingCancellationReason;
      refundKeyForBooking: (bookingId: string) => string;
    },
  ): Promise<{
    response: AssuredRideLifecycleResponseDto;
    cancelledForNotify: Array<{ bookingId: string; passengerId: string }>;
  }> {
    const ride = await this.lockRideForUpdate(manager, params.rideId);
    if (params.requireDriverOwnership && ride.driverId !== params.cancelledByUserId) {
      throw new NotFoundException('Ride not found');
    }

    if (ride.rideType !== RideType.COMMUTE) {
      throw new ConflictException('Ride is not a Commute ride');
    }

    if (ride.status === RideStatus.COMPLETED) {
      throw new ConflictException('Completed rides cannot be cancelled');
    }

    if (ride.status === RideStatus.CANCELLED) {
      if (ride.cancellationReason === params.rideCancellationReason) {
        const cancelled = await manager.getRepository(Booking).find({
          where: {
            rideId: ride.id,
            status: BookingStatus.CANCELLED,
            cancellationReason: params.bookingCancellationReason,
          },
          select: { id: true, passengerId: true },
        });
        return {
          response: this.toRideCancelResponse(ride, 0n, cancelled.length, true),
          cancelledForNotify: cancelled.map((booking) => ({
            bookingId: booking.id,
            passengerId: booking.passengerId,
          })),
        };
      }
      throw new ConflictException(
        `Ride is already cancelled (${ride.cancellationReason})`,
      );
    }

    const allowInProgressNoShow =
      ride.status === RideStatus.IN_PROGRESS &&
      params.rideCancellationReason === RideCancellationReason.DRIVER_NO_SHOW;
    if (ride.status !== RideStatus.PUBLISHED && !allowInProgressNoShow) {
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
    const cancelledForNotify: Array<{
      bookingId: string;
      passengerId: string;
    }> = [];
    for (const booking of activeBookings) {
      const cancelResult = await this.cancelCommuteBookingInTransaction(
        manager,
        {
          ride,
          booking,
          cancellationReason: params.bookingCancellationReason,
          refundIdempotencyKey: params.refundKeyForBooking(booking.id),
          restoreSeats: false,
        },
      );
      fareRefundedTotal += cancelResult.fareRefunded;
      if (!cancelResult.alreadyApplied) {
        cancelledForNotify.push({
          bookingId: booking.id,
          passengerId: booking.passengerId,
        });
      }
    }

    const now = new Date();
    ride.status = RideStatus.CANCELLED;
    ride.cancellationReason = params.rideCancellationReason;
    ride.cancelledByUserId = params.cancelledByUserId;
    ride.cancelledAt = now;
    await manager.getRepository(Ride).save(ride);

    return {
      response: this.toRideCancelResponse(
        ride,
        fareRefundedTotal,
        activeBookings.length,
        false,
      ),
      cancelledForNotify,
    };
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

  private async notifyPassengerCancelledDriver(booking: Booking): Promise<void> {
    const ride = await this.dataSource.getRepository(Ride).findOne({
      where: { id: booking.rideId },
    });
    if (!ride) {
      return;
    }
    await this.notificationsService.safeNotifyCommuteCancelled({
      bookingId: booking.id,
      rideId: booking.rideId,
      recipientUserId: ride.driverId,
      cancelledBy: 'passenger',
      cancellationReason: BookingCancellationReason.RIDER_CANCELLED,
    });
  }

  private async notifyRideCancelledPassengers(
    rideId: string,
    items: Array<{ bookingId: string; passengerId: string }>,
  ): Promise<void> {
    for (const item of items) {
      await this.notificationsService.safeNotifyCommuteCancelled({
        bookingId: item.bookingId,
        rideId,
        recipientUserId: item.passengerId,
        cancelledBy: 'driver',
        cancellationReason: BookingCancellationReason.RIDE_CANCELLED,
      });
    }
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
