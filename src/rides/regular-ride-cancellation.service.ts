import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingCancellationReason,
  BookingMode,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { Ride } from './entities/ride.entity';
import {
  RideCancellationReason,
  RideStatus,
  RideType,
} from './enums/ride.enums';

export interface RegularRideCancelResult {
  rideId: string;
  status: RideStatus;
  cancellationReason: RideCancellationReason | null;
  cancelledBookingCount: number;
  driverDepositForfeited: null;
  riderCompensationTotal: string;
  platformForfeiture: string;
  fareRefundedTotal: string;
  couponsIssuedCount: number;
  alreadyApplied: boolean;
  cancelledBookings: Array<{ bookingId: string; passengerId: string }>;
}

export interface RegularBookingCancelResult {
  bookingId: string;
  rideId: string;
  status: BookingStatus;
  cancellationReason: BookingCancellationReason | null;
  seatsRestored: number;
  alreadyApplied: boolean;
}

@Injectable()
export class RegularRideCancellationService {
  /**
   * Regular ride-level cancel inside the caller's transaction.
   * No wallet movement. Caller must already hold or accept a ride row lock.
   */
  async cancelRideInTransaction(
    manager: EntityManager,
    params: {
      rideId: string;
      cancelledByUserId: string;
      requireDriverOwnership: boolean;
      rideCancellationReason: RideCancellationReason;
      bookingCancellationReason: BookingCancellationReason;
    },
  ): Promise<RegularRideCancelResult> {
    const ride = await this.lockRide(manager, params.rideId);
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    if (params.requireDriverOwnership && ride.driverId !== params.cancelledByUserId) {
      throw new NotFoundException('Ride not found');
    }

    if (ride.rideType !== RideType.REGULAR) {
      throw new BadRequestException('Ride is not a Regular ride');
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
          rideId: ride.id,
          status: ride.status,
          cancellationReason: ride.cancellationReason,
          cancelledBookingCount: cancelled.length,
          driverDepositForfeited: null,
          riderCompensationTotal: '0',
          platformForfeiture: '0',
          fareRefundedTotal: '0',
          couponsIssuedCount: 0,
          alreadyApplied: true,
          cancelledBookings: cancelled.map((booking) => ({
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

    const now = new Date();
    const activeBookings = await manager.getRepository(Booking).find({
      where: {
        rideId: ride.id,
        status: In([BookingStatus.PENDING, BookingStatus.CONFIRMED]),
      },
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    for (const booking of activeBookings) {
      booking.status = BookingStatus.CANCELLED;
      booking.cancellationReason = params.bookingCancellationReason;
      booking.cancelledAt = now;
      await manager.getRepository(Booking).save(booking);
    }

    ride.status = RideStatus.CANCELLED;
    ride.cancellationReason = params.rideCancellationReason;
    ride.cancelledByUserId = params.cancelledByUserId;
    ride.cancelledAt = now;
    await manager.getRepository(Ride).save(ride);

    return {
      rideId: ride.id,
      status: ride.status,
      cancellationReason: ride.cancellationReason,
      cancelledBookingCount: activeBookings.length,
      driverDepositForfeited: null,
      riderCompensationTotal: '0',
      platformForfeiture: '0',
      fareRefundedTotal: '0',
      couponsIssuedCount: 0,
      alreadyApplied: false,
      cancelledBookings: activeBookings.map((booking) => ({
        bookingId: booking.id,
        passengerId: booking.passengerId,
      })),
    };
  }

  /**
   * Regular booking-only exit: cancel the booking and restore seats.
   * No wallet movement. Ride and other bookings remain.
   */
  async cancelBookingInTransaction(
    manager: EntityManager,
    params: {
      bookingId: string;
      cancellationReason: BookingCancellationReason;
    },
  ): Promise<RegularBookingCancelResult> {
    const bookingPeek = await manager.getRepository(Booking).findOne({
      where: { id: params.bookingId },
    });
    if (!bookingPeek) {
      throw new NotFoundException('Booking not found');
    }

    const ride = await this.lockRide(manager, bookingPeek.rideId);
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    const booking = await this.lockBooking(manager, params.bookingId);
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.bookingMode !== BookingMode.REGULAR) {
      throw new BadRequestException('Booking is not a Regular booking');
    }

    if (booking.status === BookingStatus.CANCELLED) {
      if (booking.cancellationReason === params.cancellationReason) {
        return {
          bookingId: booking.id,
          rideId: ride.id,
          status: booking.status,
          cancellationReason: booking.cancellationReason,
          seatsRestored: 0,
          alreadyApplied: true,
        };
      }
      throw new ConflictException(
        `Booking is already cancelled (${booking.cancellationReason})`,
      );
    }

    if (
      booking.status === BookingStatus.COMPLETED ||
      ride.status === RideStatus.COMPLETED
    ) {
      throw new ConflictException('Completed bookings cannot be cancelled');
    }

    if (ride.status === RideStatus.CANCELLED) {
      throw new ConflictException('Ride is already cancelled');
    }

    const now = new Date();
    const seatsRestored = booking.seats;
    ride.availableSeats = Math.min(
      ride.totalSeats,
      ride.availableSeats + seatsRestored,
    );
    booking.status = BookingStatus.CANCELLED;
    booking.cancellationReason = params.cancellationReason;
    booking.cancelledAt = now;
    await manager.getRepository(Booking).save(booking);
    await manager.getRepository(Ride).save(ride);

    return {
      bookingId: booking.id,
      rideId: ride.id,
      status: booking.status,
      cancellationReason: booking.cancellationReason,
      seatsRestored,
      alreadyApplied: false,
    };
  }

  private lockRide(manager: EntityManager, rideId: string) {
    return manager
      .getRepository(Ride)
      .createQueryBuilder('ride')
      .setLock('pessimistic_write')
      .where('ride.id = :rideId', { rideId })
      .getOne();
  }

  private lockBooking(manager: EntityManager, bookingId: string) {
    return manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .setLock('pessimistic_write')
      .where('booking.id = :bookingId', { bookingId })
      .getOne();
  }
}
