import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  QueryFailedError,
  Repository,
} from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingCancellationReason,
  BookingMode,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import {
  UserCoupon,
  UserCouponStatus,
  UserCouponType,
} from '../coupons/entities/user-coupon.entity';
import { Ride } from '../rides/entities/ride.entity';
import {
  RegularSeatsPolicy,
  RideCancellationReason,
  RideStatus,
  RideType,
} from '../rides/enums/ride.enums';
import {
  WalletHold,
  WalletHoldStatus,
} from '../wallet/entities/wallet-hold.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import { WalletTransactionType } from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import {
  PLATFORM_USER_ID,
  PLATFORM_WALLET_ID,
} from '../wallet/platform-wallet.constants';
import { WalletService } from '../wallet/wallet.service';
import {
  DRIVER_FORFEIT_RIDER_SHARE_PERCENT,
  PARTIAL_FILL_MAX_SEATS,
  calculatePartialFillCompensation,
  distributeEvenlyWithRemainder,
  percentOfAmountHalfUp,
} from './assured-lifecycle.math';
import {
  calculateAssuredHalfTime,
  isAtOrAfterDeparture,
  isBeforeDeparture,
} from './assured-timing';
import {
  AssuredBookingLifecycleResponseDto,
  AssuredRideLifecycleResponseDto,
  HalfTimeDecisionResponseDto,
} from './dto/assured-lifecycle-response.dto';
import {
  AssuredLifecycleEvent,
  AssuredLifecycleEventType,
} from './entities/assured-lifecycle-event.entity';

const COUPON_SOURCE_RIDER_NO_SHOW = 'ASSURED_RIDER_NO_SHOW';
const REF_DRIVER_FORFEIT_COMP = 'ASSURED_DRIVER_FORFEIT_COMP';
const REF_PLATFORM_FORFEITURE = 'ASSURED_PLATFORM_FORFEITURE';
const REF_PARTIAL_FILL = 'ASSURED_PARTIAL_FILL_COMPENSATION';

type DriverForfeitEvent =
  | AssuredLifecycleEventType.DRIVER_CANCEL
  | AssuredLifecycleEventType.DRIVER_NO_SHOW;

@Injectable()
export class AssuredLifecycleService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly walletService: WalletService,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
  ) {}

  async cancelRideByDriver(
    driverId: string,
    rideId: string,
  ): Promise<AssuredRideLifecycleResponseDto> {
    const idempotencyKey = `assured:driver-cancel:${rideId}`;
    try {
      return await this.dataSource.transaction((manager) =>
        this.executeDriverForfeit(manager, {
          actorUserId: driverId,
          rideId,
          eventType: AssuredLifecycleEventType.DRIVER_CANCEL,
          rideCancellationReason: RideCancellationReason.DRIVER_CANCELLED,
          bookingCancellationReason: BookingCancellationReason.RIDE_CANCELLED,
          idempotencyKey,
          platformEventSuffix: 'driver-cancel',
          requireOwnership: true,
          timing: 'before_departure',
        }),
      );
    } catch (error) {
      if (this.isLifecycleEventUniqueViolation(error, idempotencyKey)) {
        return this.buildRideLifecycleResponseFromDb(rideId, true);
      }
      throw error;
    }
  }

  async reportDriverNoShow(
    reporterPassengerId: string,
    rideId: string,
  ): Promise<AssuredRideLifecycleResponseDto> {
    const idempotencyKey = `assured:driver-no-show:${rideId}`;
    try {
      return await this.dataSource.transaction((manager) =>
        this.executeDriverForfeit(manager, {
          actorUserId: reporterPassengerId,
          rideId,
          eventType: AssuredLifecycleEventType.DRIVER_NO_SHOW,
          rideCancellationReason: RideCancellationReason.DRIVER_NO_SHOW,
          bookingCancellationReason: BookingCancellationReason.DRIVER_NO_SHOW,
          idempotencyKey,
          platformEventSuffix: 'driver-no-show',
          requireOwnership: false,
          timing: 'at_or_after_departure',
          reporterPassengerId,
        }),
      );
    } catch (error) {
      if (this.isLifecycleEventUniqueViolation(error, idempotencyKey)) {
        return this.buildRideLifecycleResponseFromDb(rideId, true);
      }
      throw error;
    }
  }

  async cancelBookingByRider(
    passengerId: string,
    bookingId: string,
  ): Promise<AssuredBookingLifecycleResponseDto> {
    const idempotencyKey = `assured:rider-cancel:${bookingId}`;
    try {
      return await this.dataSource.transaction((manager) =>
        this.executeRiderBookingExit(manager, {
          actorUserId: passengerId,
          bookingId,
          eventType: AssuredLifecycleEventType.RIDER_CANCEL,
          cancellationReason: BookingCancellationReason.RIDER_CANCELLED,
          idempotencyKey,
          timing: 'before_departure',
          requirePassengerOwnership: true,
          requireDriverOwnership: false,
          requireConfirmed: false,
          issueNoShowCoupon: false,
          partialFillSuffix: `rider-cancel:${bookingId}`,
        }),
      );
    } catch (error) {
      if (this.isLifecycleEventUniqueViolation(error, idempotencyKey)) {
        return this.buildBookingLifecycleResponseFromDb(bookingId, true);
      }
      throw error;
    }
  }

  async reportRiderNoShow(
    driverId: string,
    bookingId: string,
  ): Promise<AssuredBookingLifecycleResponseDto> {
    const idempotencyKey = `assured:rider-no-show:${bookingId}`;
    try {
      return await this.dataSource.transaction((manager) =>
        this.executeRiderBookingExit(manager, {
          actorUserId: driverId,
          bookingId,
          eventType: AssuredLifecycleEventType.RIDER_NO_SHOW,
          cancellationReason: BookingCancellationReason.RIDER_NO_SHOW,
          idempotencyKey,
          timing: 'at_or_after_departure',
          requirePassengerOwnership: false,
          requireDriverOwnership: true,
          requireConfirmed: true,
          issueNoShowCoupon: true,
          partialFillSuffix: `rider-no-show:${bookingId}`,
        }),
      );
    } catch (error) {
      if (this.isLifecycleEventUniqueViolation(error, idempotencyKey)) {
        return this.buildBookingLifecycleResponseFromDb(bookingId, true, true);
      }
      throw error;
    }
  }

  async decideRegularSeatsPolicy(
    driverId: string,
    rideId: string,
    policy: RegularSeatsPolicy,
  ): Promise<HalfTimeDecisionResponseDto> {
    const idempotencyKey = `assured:half-time:${rideId}`;
    try {
      return await this.dataSource.transaction(async (manager) => {
        const ride = await this.lockRide(manager, rideId);
        if (!ride || ride.driverId !== driverId) {
          throw new NotFoundException('Ride not found');
        }

        if (ride.rideType !== RideType.ASSURED) {
          throw new BadRequestException(
            'Half-time policy applies only to Assured rides',
          );
        }

        if (
          ride.status === RideStatus.COMPLETED ||
          ride.status === RideStatus.CANCELLED
        ) {
          throw new ConflictException(
            `Cannot set regular seats policy when ride is ${ride.status}`,
          );
        }

        if (ride.status !== RideStatus.PUBLISHED) {
          throw new ConflictException(
            `Cannot set regular seats policy from status ${ride.status}`,
          );
        }

        if (
          ride.regularSeatsPolicy != null &&
          ride.regularSeatsDecidedAt != null
        ) {
          if (ride.regularSeatsPolicy === policy) {
            return {
              rideId: ride.id,
              policy: ride.regularSeatsPolicy,
              decidedAt: ride.regularSeatsDecidedAt.toISOString(),
              alreadyApplied: true,
            };
          }
          throw new ConflictException(
            'Regular seats policy has already been decided for this ride',
          );
        }

        const existingEvent = await manager
          .getRepository(AssuredLifecycleEvent)
          .findOne({ where: { idempotencyKey } });
        if (existingEvent) {
          return {
            rideId: ride.id,
            policy: ride.regularSeatsPolicy ?? policy,
            decidedAt: (
              ride.regularSeatsDecidedAt ?? existingEvent.createdAt
            ).toISOString(),
            alreadyApplied: true,
          };
        }

        const regularBooking = await manager.getRepository(Booking).findOne({
          where: {
            rideId: ride.id,
            bookingMode: BookingMode.REGULAR,
          },
        });
        if (regularBooking) {
          throw new ConflictException(
            'Cannot change regular seats policy after a REGULAR booking exists on this ride',
          );
        }

        const now = new Date();
        const halfTime = calculateAssuredHalfTime(
          ride.createdAt,
          ride.departureDate,
          ride.departureTime,
        );
        if (now.getTime() < halfTime.getTime()) {
          throw new ConflictException(
            'Half-time has not been reached for this ride',
          );
        }

        await this.insertLifecycleEvent(manager, {
          eventType: AssuredLifecycleEventType.HALF_TIME_DECISION,
          rideId: ride.id,
          bookingId: null,
          actorUserId: driverId,
          idempotencyKey,
          amount: null,
          metadata: { policy },
        });

        ride.regularSeatsPolicy = policy;
        ride.regularSeatsDecidedAt = now;
        await manager.getRepository(Ride).save(ride);

        return {
          rideId: ride.id,
          policy,
          decidedAt: now.toISOString(),
          alreadyApplied: false,
        };
      });
    } catch (error) {
      if (this.isLifecycleEventUniqueViolation(error, idempotencyKey)) {
        const ride = await this.rideRepository.findOne({ where: { id: rideId } });
        if (!ride || ride.regularSeatsPolicy == null) {
          throw error;
        }
        return {
          rideId: ride.id,
          policy: ride.regularSeatsPolicy,
          decidedAt: (ride.regularSeatsDecidedAt ?? new Date()).toISOString(),
          alreadyApplied: true,
        };
      }
      throw error;
    }
  }

  /**
   * Platform → driver partial-fill compensation for empty Assured seats.
   * Caller owns the surrounding transaction and ride lock.
   * @returns compensation amount in points (0 when not applicable)
   */
  async payPartialFillIfApplicable(
    manager: EntityManager,
    ride: Ride,
    seatsToCover: number,
    eventKeySuffix: string,
  ): Promise<bigint> {
    if (ride.rideType !== RideType.ASSURED) {
      return 0n;
    }

    const effectivePolicy =
      ride.regularSeatsPolicy ?? RegularSeatsPolicy.KEEP_ASSURED_ONLY;
    if (effectivePolicy === RegularSeatsPolicy.ALLOW_REGULAR_RIDERS) {
      return 0n;
    }

    if (!Number.isInteger(seatsToCover) || seatsToCover <= 0) {
      return 0n;
    }

    const seatsBudget = Math.min(
      seatsToCover,
      PARTIAL_FILL_MAX_SEATS - ride.partialFillCompensatedSeats,
    );
    if (seatsBudget <= 0) {
      return 0n;
    }

    const amount = calculatePartialFillCompensation(
      seatsBudget,
      BigInt(ride.pricePerSeat),
    );
    if (amount <= 0n) {
      return 0n;
    }

    const idempotencyKey = `assured:partial-fill:${ride.id}:${eventKeySuffix}`;
    const existingEvent = await manager
      .getRepository(AssuredLifecycleEvent)
      .findOne({ where: { idempotencyKey } });
    if (existingEvent) {
      return existingEvent.amount != null ? BigInt(existingEvent.amount) : 0n;
    }

    await this.insertLifecycleEvent(manager, {
      eventType: AssuredLifecycleEventType.PARTIAL_FILL_COMPENSATION,
      rideId: ride.id,
      bookingId: null,
      actorUserId: null,
      idempotencyKey,
      amount: amount.toString(),
      metadata: { seatsBudget, seatsToCover },
    });

    const driverWallet = await manager.getRepository(Wallet).findOne({
      where: { userId: ride.driverId },
    });
    if (!driverWallet) {
      throw new NotFoundException('Driver wallet not found');
    }

    // Debit platform first (balance check), then credit driver.
    await this.walletService.debitPointsInTransaction(manager, {
      walletId: PLATFORM_WALLET_ID,
      userId: PLATFORM_USER_ID,
      amount,
      referenceType: REF_PARTIAL_FILL,
      referenceId: ride.id,
      idempotencyKey: `${idempotencyKey}:debit`,
      transactionType: WalletTransactionType.ASSURED_PARTIAL_FILL_COMPENSATION,
      allowPlatformOperations: true,
    });

    await this.walletService.creditPointsInTransaction(manager, {
      walletId: driverWallet.id,
      userId: ride.driverId,
      amount,
      sourceType: WalletPointSource.DRIVER_EARNED,
      referenceType: REF_PARTIAL_FILL,
      referenceId: ride.id,
      idempotencyKey: `${idempotencyKey}:credit`,
      transactionType: WalletTransactionType.ASSURED_PARTIAL_FILL_COMPENSATION,
    });

    ride.partialFillCompensatedSeats += seatsBudget;
    await manager.getRepository(Ride).save(ride);

    return amount;
  }

  private async executeDriverForfeit(
    manager: EntityManager,
    params: {
      actorUserId: string;
      rideId: string;
      eventType: DriverForfeitEvent;
      rideCancellationReason: RideCancellationReason;
      bookingCancellationReason: BookingCancellationReason;
      idempotencyKey: string;
      platformEventSuffix: string;
      requireOwnership: boolean;
      timing: 'before_departure' | 'at_or_after_departure';
      reporterPassengerId?: string;
    },
  ): Promise<AssuredRideLifecycleResponseDto> {
    const ride = await this.lockRide(manager, params.rideId);

    if (params.requireOwnership) {
      if (!ride || ride.driverId !== params.actorUserId) {
        throw new NotFoundException('Ride not found');
      }
    } else {
      if (!ride) {
        throw new NotFoundException('Ride not found');
      }

      const reporterHadAssuredBooking = await manager
        .getRepository(Booking)
        .findOne({
          where: {
            rideId: ride.id,
            passengerId: params.reporterPassengerId!,
            bookingMode: BookingMode.ASSURED,
          },
        });
      if (!reporterHadAssuredBooking) {
        throw new NotFoundException('Ride not found');
      }

      // Allow idempotent retries after the ride was cancelled by a prior no-show.
      if (
        ride.status === RideStatus.CANCELLED &&
        ride.cancellationReason === params.rideCancellationReason
      ) {
        return this.buildRideLifecycleResponse(manager, ride, true);
      }

      if (ride.status !== RideStatus.PUBLISHED) {
        throw new NotFoundException('Ride not found');
      }

      if (
        reporterHadAssuredBooking.status !== BookingStatus.PENDING &&
        reporterHadAssuredBooking.status !== BookingStatus.CONFIRMED
      ) {
        throw new NotFoundException('Ride not found');
      }
    }

    if (ride.rideType !== RideType.ASSURED) {
      throw new BadRequestException(
        'Assured lifecycle actions apply only to Assured rides',
      );
    }

    if (ride.status === RideStatus.COMPLETED) {
      throw new ConflictException('Completed rides cannot be cancelled');
    }

    if (ride.status === RideStatus.CANCELLED) {
      if (ride.cancellationReason === params.rideCancellationReason) {
        return this.buildRideLifecycleResponse(manager, ride, true);
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

    const now = new Date();
    if (params.timing === 'before_departure') {
      if (
        !isBeforeDeparture(now, ride.departureDate, ride.departureTime)
      ) {
        throw new ConflictException(
          'Driver cannot cancel after departure; use no-show flow',
        );
      }
    } else if (
      !isAtOrAfterDeparture(now, ride.departureDate, ride.departureTime)
    ) {
      throw new ConflictException(
        'Driver no-show can only be reported at or after departure',
      );
    }

    const existingEvent = await manager
      .getRepository(AssuredLifecycleEvent)
      .findOne({ where: { idempotencyKey: params.idempotencyKey } });
    if (existingEvent) {
      return this.buildRideLifecycleResponse(manager, ride, true);
    }

    await this.insertLifecycleEvent(manager, {
      eventType: params.eventType,
      rideId: ride.id,
      bookingId: null,
      actorUserId: params.actorUserId,
      idempotencyKey: params.idempotencyKey,
      amount: null,
      metadata: null,
    });

    const assuredBookings = await manager.getRepository(Booking).find({
      where: {
        rideId: ride.id,
        bookingMode: BookingMode.ASSURED,
        status: In([BookingStatus.PENDING, BookingStatus.CONFIRMED]),
      },
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    const allActiveBookings = await manager.getRepository(Booking).find({
      where: {
        rideId: ride.id,
        status: In([BookingStatus.PENDING, BookingStatus.CONFIRMED]),
      },
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    // Holds: Ride already locked → lock/process holds by (walletId, holdId).
    let driverHoldAmount = 0n;
    const holdOps: Array<{
      holdId: string;
      walletId: string;
      action: 'consume' | 'release';
    }> = [];

    if (ride.driverDepositHoldId) {
      const driverHold = await manager.getRepository(WalletHold).findOne({
        where: { id: ride.driverDepositHoldId },
      });
      if (driverHold && driverHold.status === WalletHoldStatus.ACTIVE) {
        driverHoldAmount = BigInt(driverHold.amount);
        holdOps.push({
          holdId: driverHold.id,
          walletId: driverHold.walletId,
          action: 'consume',
        });
      }
    }

    for (const booking of assuredBookings) {
      if (!booking.walletHoldId) {
        continue;
      }
      const riderHold = await manager.getRepository(WalletHold).findOne({
        where: { id: booking.walletHoldId },
      });
      if (riderHold && riderHold.status === WalletHoldStatus.ACTIVE) {
        holdOps.push({
          holdId: riderHold.id,
          walletId: riderHold.walletId,
          action: 'release',
        });
      }
    }

    holdOps.sort((a, b) => {
      const walletCmp = a.walletId.localeCompare(b.walletId);
      if (walletCmp !== 0) {
        return walletCmp;
      }
      return a.holdId.localeCompare(b.holdId);
    });

    for (const op of holdOps) {
      if (op.action === 'consume') {
        const result = await this.walletService.consumeHoldInTransaction(
          manager,
          {
            holdId: op.holdId,
            idempotencyKey: `assured-deposit-consume:${op.holdId}`,
          },
        );
        driverHoldAmount = BigInt(result.hold?.amount ?? driverHoldAmount);
      } else {
        await this.walletService.releaseHoldInTransaction(manager, {
          holdId: op.holdId,
          idempotencyKey: `assured-deposit-release:${op.holdId}`,
        });
      }
    }

    let riderCompensationTotal = 0n;
    let platformForfeiture = 0n;

    if (driverHoldAmount > 0n) {
      if (assuredBookings.length === 0) {
        // CRITICAL: zero affected riders → 100% platform (not 60/40).
        platformForfeiture = driverHoldAmount;
        await this.walletService.creditPointsInTransaction(manager, {
          walletId: PLATFORM_WALLET_ID,
          userId: PLATFORM_USER_ID,
          amount: platformForfeiture,
          sourceType: WalletPointSource.PURCHASED,
          referenceType: REF_PLATFORM_FORFEITURE,
          referenceId: ride.id,
          idempotencyKey: `assured:platform-forfeit:${ride.id}:${params.platformEventSuffix}`,
          transactionType: WalletTransactionType.ASSURED_PLATFORM_FORFEITURE,
          allowPlatformOperations: true,
        });
      } else {
        const riderShare = percentOfAmountHalfUp(
          driverHoldAmount,
          DRIVER_FORFEIT_RIDER_SHARE_PERCENT,
        );
        platformForfeiture = driverHoldAmount - riderShare;
        const shares = distributeEvenlyWithRemainder(
          riderShare,
          assuredBookings.length,
        );

        const passengerIds = [
          ...new Set(assuredBookings.map((b) => b.passengerId)),
        ];
        const wallets = await manager.getRepository(Wallet).find({
          where: { userId: In(passengerIds) },
        });
        const walletByUserId = new Map(
          wallets.map((w) => [w.userId, w] as const),
        );

        const creditPlan: Array<{
          walletId: string;
          userId: string;
          amount: bigint;
          bookingId: string;
          kind: 'rider' | 'platform';
        }> = [];

        for (let i = 0; i < assuredBookings.length; i += 1) {
          const booking = assuredBookings[i];
          const share = shares[i] ?? 0n;
          if (share <= 0n) {
            continue;
          }
          const wallet = walletByUserId.get(booking.passengerId);
          if (!wallet) {
            throw new NotFoundException('Rider wallet not found');
          }
          creditPlan.push({
            walletId: wallet.id,
            userId: booking.passengerId,
            amount: share,
            bookingId: booking.id,
            kind: 'rider',
          });
          riderCompensationTotal += share;
        }

        if (platformForfeiture > 0n) {
          creditPlan.push({
            walletId: PLATFORM_WALLET_ID,
            userId: PLATFORM_USER_ID,
            amount: platformForfeiture,
            bookingId: '',
            kind: 'platform',
          });
        }

        creditPlan.sort((a, b) => a.walletId.localeCompare(b.walletId));

        for (const credit of creditPlan) {
          if (credit.kind === 'rider') {
            await this.walletService.creditPointsInTransaction(manager, {
              walletId: credit.walletId,
              userId: credit.userId,
              amount: credit.amount,
              sourceType: WalletPointSource.PURCHASED,
              referenceType: REF_DRIVER_FORFEIT_COMP,
              referenceId: ride.id,
              idempotencyKey: `assured:rider-comp:${ride.id}:${credit.bookingId}`,
              transactionType:
                WalletTransactionType.ASSURED_RIDER_COMPENSATION,
            });
          } else {
            await this.walletService.creditPointsInTransaction(manager, {
              walletId: PLATFORM_WALLET_ID,
              userId: PLATFORM_USER_ID,
              amount: credit.amount,
              sourceType: WalletPointSource.PURCHASED,
              referenceType: REF_PLATFORM_FORFEITURE,
              referenceId: ride.id,
              idempotencyKey: `assured:platform-forfeit:${ride.id}:${params.platformEventSuffix}`,
              transactionType:
                WalletTransactionType.ASSURED_PLATFORM_FORFEITURE,
              allowPlatformOperations: true,
            });
          }
        }
      }
    }

    for (const booking of allActiveBookings) {
      this.restoreSeats(ride, booking.seats);
      booking.status = BookingStatus.CANCELLED;
      booking.cancellationReason = params.bookingCancellationReason;
      booking.cancelledAt = now;
      await manager.getRepository(Booking).save(booking);
    }

    ride.status = RideStatus.CANCELLED;
    ride.cancellationReason = params.rideCancellationReason;
    ride.cancelledByUserId = params.actorUserId;
    ride.cancelledAt = now;
    await manager.getRepository(Ride).save(ride);

    await manager.getRepository(AssuredLifecycleEvent).update(
      { idempotencyKey: params.idempotencyKey },
      {
        amount: driverHoldAmount > 0n ? driverHoldAmount.toString() : null,
        metadata: {
          riderCompensationTotal: riderCompensationTotal.toString(),
          platformForfeiture: platformForfeiture.toString(),
          cancelledBookingCount: allActiveBookings.length,
        },
      },
    );

    return {
      rideId: ride.id,
      status: ride.status,
      cancellationReason: ride.cancellationReason,
      cancelledBookingCount: allActiveBookings.length,
      driverDepositForfeited:
        driverHoldAmount > 0n ? driverHoldAmount.toString() : null,
      riderCompensationTotal: riderCompensationTotal.toString(),
      platformForfeiture: platformForfeiture.toString(),
      alreadyApplied: false,
    };
  }

  private async executeRiderBookingExit(
    manager: EntityManager,
    params: {
      actorUserId: string;
      bookingId: string;
      eventType:
        | AssuredLifecycleEventType.RIDER_CANCEL
        | AssuredLifecycleEventType.RIDER_NO_SHOW;
      cancellationReason: BookingCancellationReason;
      idempotencyKey: string;
      timing: 'before_departure' | 'at_or_after_departure';
      requirePassengerOwnership: boolean;
      requireDriverOwnership: boolean;
      requireConfirmed: boolean;
      issueNoShowCoupon: boolean;
      partialFillSuffix: string;
    },
  ): Promise<AssuredBookingLifecycleResponseDto> {
    // Lock order: Ride → Booking (matches driver cancel / completion; avoids deadlock).
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

    if (
      params.requirePassengerOwnership &&
      booking.passengerId !== params.actorUserId
    ) {
      throw new NotFoundException('Booking not found');
    }

    if (
      params.requireDriverOwnership &&
      ride.driverId !== params.actorUserId
    ) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.status === BookingStatus.CANCELLED) {
      if (booking.cancellationReason === params.cancellationReason) {
        return this.buildBookingLifecycleResponse(
          manager,
          booking,
          true,
          params.issueNoShowCoupon,
        );
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

    // Regular bookings on Assured (or Regular) rides: cancel + restore seats only.
    if (booking.bookingMode !== BookingMode.ASSURED) {
      if (
        params.eventType === AssuredLifecycleEventType.RIDER_NO_SHOW
      ) {
        throw new BadRequestException(
          'Rider no-show applies only to Assured-mode bookings',
        );
      }

      const now = new Date();
      const seatsRestored = booking.seats;
      this.restoreSeats(ride, seatsRestored);
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
        partialFillCompensation: null,
        alreadyApplied: false,
      };
    }

    if (ride.rideType !== RideType.ASSURED) {
      throw new BadRequestException(
        'Assured booking lifecycle applies only on Assured rides',
      );
    }

    if (params.requireConfirmed && booking.status !== BookingStatus.CONFIRMED) {
      throw new ConflictException(
        'Rider no-show requires a CONFIRMED Assured booking',
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

    const now = new Date();
    if (params.timing === 'before_departure') {
      if (
        !isBeforeDeparture(now, ride.departureDate, ride.departureTime)
      ) {
        throw new ConflictException(
          'Assured riders cannot cancel after departure; use no-show flow',
        );
      }
    } else if (
      !isAtOrAfterDeparture(now, ride.departureDate, ride.departureTime)
    ) {
      throw new ConflictException(
        'Rider no-show can only be reported at or after departure',
      );
    }

    const existingEvent = await manager
      .getRepository(AssuredLifecycleEvent)
      .findOne({ where: { idempotencyKey: params.idempotencyKey } });
    if (existingEvent) {
      return this.buildBookingLifecycleResponse(
        manager,
        booking,
        true,
        params.issueNoShowCoupon,
      );
    }

    await this.insertLifecycleEvent(manager, {
      eventType: params.eventType,
      rideId: ride.id,
      bookingId: booking.id,
      actorUserId: params.actorUserId,
      idempotencyKey: params.idempotencyKey,
      amount: booking.assuredDepositAmount,
      metadata: null,
    });

    if (booking.walletHoldId) {
      const hold = await manager.getRepository(WalletHold).findOne({
        where: { id: booking.walletHoldId },
      });
      if (
        hold &&
        hold.status === WalletHoldStatus.ACTIVE &&
        BigInt(hold.amount) > 0n
      ) {
        const consumeResult =
          await this.walletService.consumeHoldInTransaction(manager, {
            holdId: hold.id,
            idempotencyKey: `assured-deposit-consume:${hold.id}`,
          });
        const forfeited = BigInt(
          consumeResult.hold?.amount ?? hold.amount,
        );
        if (forfeited > 0n) {
          await this.walletService.creditPointsInTransaction(manager, {
            walletId: PLATFORM_WALLET_ID,
            userId: PLATFORM_USER_ID,
            amount: forfeited,
            sourceType: WalletPointSource.PURCHASED,
            referenceType: REF_PLATFORM_FORFEITURE,
            referenceId: booking.id,
            idempotencyKey: `assured:platform-forfeit:booking:${booking.id}:${params.eventType}`,
            transactionType:
              WalletTransactionType.ASSURED_PLATFORM_FORFEITURE,
            allowPlatformOperations: true,
          });
        }
      }
    }

    const seatsRestored = booking.seats;
    this.restoreSeats(ride, seatsRestored);
    booking.status = BookingStatus.CANCELLED;
    booking.cancellationReason = params.cancellationReason;
    booking.cancelledAt = now;
    await manager.getRepository(Booking).save(booking);

    let couponIssued = false;
    if (params.issueNoShowCoupon) {
      couponIssued = await this.issueRiderNoShowCoupon(
        manager,
        booking.passengerId,
        booking.id,
      );
    }

    const partialFillAmount = await this.payPartialFillIfApplicable(
      manager,
      ride,
      seatsRestored,
      params.partialFillSuffix,
    );

    await manager.getRepository(Ride).save(ride);

    return {
      bookingId: booking.id,
      rideId: ride.id,
      status: booking.status,
      cancellationReason: booking.cancellationReason,
      seatsRestored,
      partialFillCompensation:
        partialFillAmount > 0n ? partialFillAmount.toString() : null,
      couponIssued: params.issueNoShowCoupon ? couponIssued : undefined,
      alreadyApplied: false,
    };
  }

  private async issueRiderNoShowCoupon(
    manager: EntityManager,
    userId: string,
    bookingId: string,
  ): Promise<boolean> {
    const existing = await manager.getRepository(UserCoupon).findOne({
      where: {
        sourceReferenceType: COUPON_SOURCE_RIDER_NO_SHOW,
        sourceReferenceId: bookingId,
      },
    });
    if (existing) {
      return true;
    }

    try {
      const coupon = manager.getRepository(UserCoupon).create({
        userId,
        couponType: UserCouponType.NEXT_ASSURED_DEPOSIT_FREE,
        status: UserCouponStatus.UNUSED,
        sourceReferenceType: COUPON_SOURCE_RIDER_NO_SHOW,
        sourceReferenceId: bookingId,
        usedAt: null,
        usedBookingId: null,
        expiresAt: null,
      });
      await manager.getRepository(UserCoupon).save(coupon);
      return true;
    } catch (error) {
      if (this.isUniqueViolation(error, 'UQ_user_coupons_source')) {
        return true;
      }
      throw error;
    }
  }

  private restoreSeats(ride: Ride, seats: number): void {
    ride.availableSeats = Math.min(
      ride.totalSeats,
      ride.availableSeats + seats,
    );
  }

  private async lockRide(
    manager: EntityManager,
    rideId: string,
  ): Promise<Ride | null> {
    return manager
      .getRepository(Ride)
      .createQueryBuilder('ride')
      .setLock('pessimistic_write')
      .where('ride.id = :rideId', { rideId })
      .getOne();
  }

  private async lockBooking(
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

  private async insertLifecycleEvent(
    manager: EntityManager,
    input: {
      eventType: AssuredLifecycleEventType;
      rideId: string | null;
      bookingId: string | null;
      actorUserId: string | null;
      idempotencyKey: string;
      amount: string | null;
      metadata: Record<string, unknown> | null;
    },
  ): Promise<AssuredLifecycleEvent> {
    const event = manager.getRepository(AssuredLifecycleEvent).create({
      eventType: input.eventType,
      rideId: input.rideId,
      bookingId: input.bookingId,
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      amount: input.amount,
      metadata: input.metadata,
    });
    return manager.getRepository(AssuredLifecycleEvent).save(event);
  }

  private async buildRideLifecycleResponse(
    manager: EntityManager,
    ride: Ride,
    alreadyApplied: boolean,
  ): Promise<AssuredRideLifecycleResponseDto> {
    const event = await manager.getRepository(AssuredLifecycleEvent).findOne({
      where: [
        { idempotencyKey: `assured:driver-cancel:${ride.id}` },
        { idempotencyKey: `assured:driver-no-show:${ride.id}` },
      ],
      order: { createdAt: 'ASC' },
    });

    const metadata = (event?.metadata ?? {}) as {
      riderCompensationTotal?: string;
      platformForfeiture?: string;
      cancelledBookingCount?: number;
    };

    const cancelledCount =
      metadata.cancelledBookingCount ??
      (await manager.getRepository(Booking).count({
        where: {
          rideId: ride.id,
          status: BookingStatus.CANCELLED,
        },
      }));

    return {
      rideId: ride.id,
      status: ride.status,
      cancellationReason: ride.cancellationReason,
      cancelledBookingCount: cancelledCount,
      driverDepositForfeited: event?.amount ?? ride.assuredDepositAmount,
      riderCompensationTotal: metadata.riderCompensationTotal ?? '0',
      platformForfeiture: metadata.platformForfeiture ?? '0',
      alreadyApplied,
    };
  }

  private async buildRideLifecycleResponseFromDb(
    rideId: string,
    alreadyApplied: boolean,
  ): Promise<AssuredRideLifecycleResponseDto> {
    const ride = await this.rideRepository.findOne({ where: { id: rideId } });
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }
    return this.dataSource.transaction((manager) =>
      this.buildRideLifecycleResponse(manager, ride, alreadyApplied),
    );
  }

  private async buildBookingLifecycleResponse(
    manager: EntityManager,
    booking: Booking,
    alreadyApplied: boolean,
    includeCoupon?: boolean,
  ): Promise<AssuredBookingLifecycleResponseDto> {
    let couponIssued: boolean | undefined;
    if (includeCoupon) {
      const coupon = await manager.getRepository(UserCoupon).findOne({
        where: {
          sourceReferenceType: COUPON_SOURCE_RIDER_NO_SHOW,
          sourceReferenceId: booking.id,
        },
      });
      couponIssued = Boolean(coupon);
    }

    const partialEvent = await manager
      .getRepository(AssuredLifecycleEvent)
      .findOne({
        where: [
          {
            idempotencyKey: `assured:partial-fill:${booking.rideId}:rider-cancel:${booking.id}`,
          },
          {
            idempotencyKey: `assured:partial-fill:${booking.rideId}:rider-no-show:${booking.id}`,
          },
        ],
      });

    return {
      bookingId: booking.id,
      rideId: booking.rideId,
      status: booking.status,
      cancellationReason: booking.cancellationReason,
      seatsRestored: booking.seats,
      partialFillCompensation: partialEvent?.amount ?? null,
      couponIssued,
      alreadyApplied,
    };
  }

  private async buildBookingLifecycleResponseFromDb(
    bookingId: string,
    alreadyApplied: boolean,
    includeCoupon = false,
  ): Promise<AssuredBookingLifecycleResponseDto> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    return this.dataSource.transaction((manager) =>
      this.buildBookingLifecycleResponse(
        manager,
        booking,
        alreadyApplied,
        includeCoupon,
      ),
    );
  }

  private isLifecycleEventUniqueViolation(
    error: unknown,
    idempotencyKey: string,
  ): boolean {
    if (!this.isUniqueViolation(error, 'UQ_assured_lifecycle_events_idempotency_key')) {
      // Also accept generic idempotency_key unique violations.
      if (!this.isUniqueViolation(error, 'idempotency_key')) {
        return false;
      }
    }
    void idempotencyKey;
    return true;
  }

  private isUniqueViolation(error: unknown, constraintHint: string): boolean {
    let current: unknown = error;
    while (current) {
      if (typeof current === 'object' && current !== null) {
        const record = current as {
          code?: string;
          constraint?: string;
          driverError?: { code?: string; constraint?: string };
          cause?: unknown;
        };
        const code = record.code ?? record.driverError?.code;
        const constraint =
          record.constraint ?? record.driverError?.constraint ?? '';
        if (
          code === '23505' &&
          (constraint === constraintHint ||
            constraint.includes(constraintHint))
        ) {
          return true;
        }
        if (current instanceof QueryFailedError) {
          const driverError = current.driverError as
            | { code?: string; constraint?: string }
            | undefined;
          if (
            driverError?.code === '23505' &&
            (driverError.constraint === constraintHint ||
              Boolean(driverError.constraint?.includes(constraintHint)))
          ) {
            return true;
          }
        }
        current = record.cause;
        continue;
      }
      break;
    }
    return false;
  }
}
