import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
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

import { AssuredQueueService } from '../../assured/assured-queue.service';
import {
  ASSURED_BOOKING_RIDER_DEPOSIT_REF,
  ASSURED_RIDE_DRIVER_DEPOSIT_REF,
} from '../../assured/assured-deposit.math';
import { AssuredQueueAdvanceReason } from '../../assured/enums/assured-queue.enums';
import { ChatService } from '../../chat/chat.service';
import { Booking } from '../../bookings/entities/booking.entity';
import {
  BookingCancellationReason,
  BookingPaymentStatus,
  BookingPickupStatus,
  BookingStatus,
} from '../../bookings/enums/booking.enums';
import { NotificationsService } from '../../notifications/notifications.service';
import { RideSeries } from '../../rides/entities/ride-series.entity';
import { Ride } from '../../rides/entities/ride.entity';
import {
  RideCancellationReason,
  RideSeriesStatus,
  RideStatus,
  RideType,
  SeriesScope,
} from '../../rides/enums/ride.enums';
import { TrackingService } from '../../tracking/tracking.service';
import {
  WalletHold,
  WalletHoldStatus,
} from '../../wallet/entities/wallet-hold.entity';
import { WalletPointSource } from '../../wallet/entities/wallet-point-lot.entity';
import { WalletTransactionType } from '../../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../../wallet/entities/wallet.entity';
import { WalletService } from '../../wallet/wallet.service';
import {
  AdminAlertCategory,
  AdminAlertSeverity,
} from '../entities/admin-alert.entity';
import { AdminActivityEvent } from '../entities/admin-activity-event.entity';
import {
  AdminRideCancellation,
  AdminRideCancellationBookingSnapshot,
} from '../entities/admin-ride-cancellation.entity';
import { AdminUser } from '../entities/admin-user.entity';
import {
  ADMIN_OPS_DRIVER_CANCEL_BODY,
  ADMIN_OPS_PASSENGER_CANCEL_BODY,
  ADMIN_PRETRIP_DRIVER_CANCEL_BODY,
  ADMIN_PRETRIP_PASSENGER_CANCEL_BODY,
  adminRideCancelIdempotencyKey,
  adminRideHoldReleaseKey,
  adminRideRefundKey,
} from './admin-ride.constants';
import {
  AdminCancelOccurrenceResultDto,
  AdminCancelRideDto,
  AdminCancelRideResponseDto,
} from './dto/admin-ride-cancel.dto';

const CANCELABLE_STATUSES = new Set<RideStatus>([
  RideStatus.DRAFT,
  RideStatus.PUBLISHED,
  RideStatus.ASSURANCE_PENDING,
  RideStatus.ASSURANCE_ACTIVE,
  RideStatus.IN_PROGRESS,
]);

const ACTIVE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
];

type BookingOutcome = AdminRideCancellationBookingSnapshot;

@Injectable()
export class AdminRideCancellationService {
  private readonly logger = new Logger(AdminRideCancellationService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly walletService: WalletService,
    private readonly trackingService: TrackingService,
    private readonly chatService: ChatService,
    private readonly notificationsService: NotificationsService,
    private readonly assuredQueueService: AssuredQueueService,
    @InjectRepository(AdminUser)
    private readonly adminUserRepository: Repository<AdminUser>,
  ) {}

  async cancel(
    actorUserId: string,
    rideId: string,
    dto: AdminCancelRideDto,
  ): Promise<AdminCancelRideResponseDto> {
    const admin = await this.adminUserRepository.findOne({
      where: { userId: actorUserId, isActive: true },
    });
    if (!admin) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'ADMIN_ACCESS_DENIED',
        message: 'Admin access required',
        error: 'Forbidden',
      });
    }

    const sideEffects: Array<{
      rideId: string;
      inProgress: boolean;
      driverId: string;
      passengers: Array<{ bookingId: string; passengerId: string }>;
    }> = [];

    const occurrences = await this.dataSource.transaction(async (manager) => {
      const selected = await this.lockRide(manager, rideId);
      if (selected.status === RideStatus.COMPLETED) {
        throw new ConflictException({
          statusCode: 409,
          code: 'RIDE_ALREADY_COMPLETED',
          message: 'Completed rides cannot be cancelled',
          error: 'Conflict',
        });
      }

      const scope =
        selected.seriesId != null
          ? (dto.seriesScope ?? SeriesScope.THIS_OCCURRENCE)
          : null;
      const targets = await this.resolveTargets(
        manager,
        selected,
        scope ?? SeriesScope.THIS_OCCURRENCE,
      );
      const results: AdminCancelOccurrenceResultDto[] = [];
      for (const target of targets) {
        const result = await this.cancelOneOccurrence(manager, {
          ride: target,
          admin,
          actorUserId,
          reason: dto.reason,
          seriesScope: scope,
        });
        results.push(result.dto);
        if (!result.alreadyCancelledByOther) {
          sideEffects.push({
            rideId: target.id,
            inProgress: result.wasInProgress,
            driverId: target.driverId,
            passengers: result.notifyPassengers,
          });
        }
      }

      if (selected.seriesId && scope === SeriesScope.THIS_AND_FUTURE) {
        const remaining = await manager
          .getRepository(Ride)
          .createQueryBuilder('ride')
          .where('ride.series_id = :seriesId', { seriesId: selected.seriesId })
          .andWhere('ride.status NOT IN (:...terminal)', {
            terminal: [RideStatus.CANCELLED, RideStatus.COMPLETED],
          })
          .getCount();
        if (remaining === 0) {
          await manager
            .getRepository(RideSeries)
            .update(
              { id: selected.seriesId },
              { status: RideSeriesStatus.CANCELLED },
            );
        }
      }

      return results;
    });

    for (const effect of sideEffects) {
      await this.dispatchSideEffects(effect);
    }

    const primary =
      occurrences.find((row) => row.rideId === rideId) ?? occurrences[0];
    return {
      rideId: primary.rideId,
      previousStatus: primary.previousStatus,
      finalStatus: primary.finalStatus,
      cancellationReason: primary.cancellationReason,
      adminUserId: primary.adminUserId,
      cancelledAt: primary.cancelledAt,
      seriesScope: primary.seriesScope,
      bookings: primary.bookings,
      refundTotal: primary.refundTotal,
      depositReleaseTotal: primary.depositReleaseTotal,
      compensationTotal: primary.compensationTotal,
      supportEscalationRequired: primary.supportEscalationRequired,
      alreadyApplied: occurrences.every((row) => row.alreadyApplied),
      occurrences,
    };
  }

  private async cancelOneOccurrence(
    manager: EntityManager,
    params: {
      ride: Ride;
      admin: AdminUser;
      actorUserId: string;
      reason: string;
      seriesScope: SeriesScope | null;
    },
  ): Promise<{
    dto: AdminCancelOccurrenceResultDto;
    wasInProgress: boolean;
    alreadyCancelledByOther: boolean;
    notifyPassengers: Array<{ bookingId: string; passengerId: string }>;
  }> {
    const ride = await this.lockRide(manager, params.ride.id);
    const idempotencyKey = adminRideCancelIdempotencyKey(ride.id);
    const existingAudit = await manager
      .getRepository(AdminRideCancellation)
      .findOne({ where: { idempotencyKey } });

    if (ride.status === RideStatus.COMPLETED) {
      return {
        dto: this.toSkippedDto(ride, params, RideStatus.COMPLETED),
        wasInProgress: false,
        alreadyCancelledByOther: true,
        notifyPassengers: [],
      };
    }

    if (ride.status === RideStatus.CANCELLED) {
      if (existingAudit) {
        return {
          dto: this.toOccurrenceDto(existingAudit, true),
          wasInProgress: existingAudit.supportEscalationRequired,
          alreadyCancelledByOther: false,
          notifyPassengers: this.notifyPassengersFromAudit(existingAudit),
        };
      }
      return {
        dto: this.toExistingCancelDto(ride, params),
        wasInProgress: false,
        alreadyCancelledByOther: true,
        notifyPassengers: [],
      };
    }

    if (!CANCELABLE_STATUSES.has(ride.status)) {
      throw new ConflictException({
        statusCode: 409,
        code: 'RIDE_NOT_CANCELLABLE',
        message: `Ride cannot be cancelled from status ${ride.status}`,
        error: 'Conflict',
      });
    }

    const wasInProgress = ride.status === RideStatus.IN_PROGRESS;
    const previousStatus = ride.status;
    const bookings = await manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .setLock('pessimistic_write')
      .where('booking.ride_id = :rideId', { rideId: ride.id })
      .andWhere('booking.status IN (:...statuses)', {
        statuses: ACTIVE_BOOKING_STATUSES,
      })
      .orderBy('booking.created_at', 'ASC')
      .addOrderBy('booking.id', 'ASC')
      .getMany();

    const outcomes: BookingOutcome[] = [];
    const txIds: string[] = [];
    let refundTotal = 0n;
    let depositReleaseTotal = 0n;
    const issueRefunds = !wasInProgress;

    const releasedHolds = await this.releaseAssuredHolds(
      manager,
      ride,
      bookings,
    );
    depositReleaseTotal += releasedHolds.amount;
    txIds.push(...releasedHolds.txIds);

    for (const booking of bookings) {
      const previousBookingStatus = booking.status;
      const collected = this.collectedAmount(booking);
      this.restoreReservedSeats(ride, booking);

      let refundAmount = 0n;
      if (issueRefunds) {
        const refund = await this.refundCollectedIfPaid(manager, ride, booking);
        refundAmount = refund.amount;
        refundTotal += refundAmount;
        if (refund.txId) {
          txIds.push(refund.txId);
        }
      }

      booking.status = BookingStatus.CANCELLED;
      booking.cancellationReason = BookingCancellationReason.ADMIN_CANCELLED;
      booking.cancelledAt = new Date();
      if (refundAmount > 0n) {
        booking.paymentStatus = BookingPaymentStatus.REFUNDED;
      }
      await manager.getRepository(Booking).save(booking);

      const boarded = booking.pickupStatus === BookingPickupStatus.PICKED_UP;
      outcomes.push({
        bookingId: booking.id,
        passengerId: booking.passengerId,
        previousStatus: previousBookingStatus,
        finalStatus: BookingStatus.CANCELLED,
        paymentMethod: booking.paymentMethod,
        paymentStatus: booking.paymentStatus,
        collectedAmount: collected,
        pickupStatus: booking.pickupStatus,
        boarded,
        refundAmount: refundAmount.toString(),
        compensationAmount: '0',
        depositReleasedAmount: (
          releasedHolds.byBookingId.get(booking.id) ?? 0n
        ).toString(),
        supportEscalationRequired: wasInProgress,
      });
    }

    const now = new Date();
    ride.status = RideStatus.CANCELLED;
    ride.cancellationReason = RideCancellationReason.ADMIN_CANCELLED;
    ride.cancelledByUserId = params.actorUserId;
    ride.cancelledAt = now;
    await manager.getRepository(Ride).save(ride);

    if (
      ride.rideType === RideType.ASSURED &&
      previousStatus === RideStatus.ASSURANCE_ACTIVE &&
      ride.assuredQueueId
    ) {
      await this.assuredQueueService.advanceQueueInTransaction(manager, {
        queueId: ride.assuredQueueId,
        reason: AssuredQueueAdvanceReason.ADMIN_CANCELLED,
        sourceRideId: ride.id,
      });
    }

    const audit = manager.getRepository(AdminRideCancellation).create({
      adminUserId: params.admin.id,
      adminActorUserId: params.actorUserId,
      rideId: ride.id,
      rideType: ride.rideType,
      previousStatus,
      finalStatus: RideStatus.CANCELLED,
      reason: params.reason,
      seriesScope: params.seriesScope,
      supportEscalationRequired: wasInProgress,
      refundTotal: refundTotal.toString(),
      depositReleaseTotal: depositReleaseTotal.toString(),
      compensationTotal: '0',
      alreadyApplied: false,
      bookings: outcomes,
      financialTransactionIds: txIds,
      idempotencyKey,
    });

    let saved: AdminRideCancellation;
    try {
      saved = await manager.getRepository(AdminRideCancellation).save(audit);
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }
      const recovered = await manager
        .getRepository(AdminRideCancellation)
        .findOne({ where: { idempotencyKey } });
      if (!recovered) {
        throw error;
      }
      return {
        dto: this.toOccurrenceDto(recovered, true),
        wasInProgress: recovered.supportEscalationRequired || wasInProgress,
        alreadyCancelledByOther: false,
        notifyPassengers: this.notifyPassengersFromAudit(recovered),
      };
    }

    await manager.getRepository(AdminActivityEvent).save(
      manager.getRepository(AdminActivityEvent).create({
        eventType: 'RIDE_CANCELLED_BY_ADMIN',
        category: AdminAlertCategory.RIDE,
        severity: wasInProgress
          ? AdminAlertSeverity.WARNING
          : AdminAlertSeverity.INFO,
        title: 'Ride cancelled by admin',
        description: `Ride ${ride.id} cancelled by operations`,
        metadata: {
          rideId: ride.id,
          adminUserId: params.admin.id,
          previousStatus,
          supportEscalationRequired: wasInProgress,
        },
      }),
    );

    return {
      dto: this.toOccurrenceDto(saved, false),
      wasInProgress,
      alreadyCancelledByOther: false,
      notifyPassengers: outcomes.map((row) => ({
        bookingId: row.bookingId,
        passengerId: row.passengerId,
      })),
    };
  }

  private async refundCollectedIfPaid(
    manager: EntityManager,
    ride: Ride,
    booking: Booking,
  ): Promise<{ amount: bigint; txId: string | null }> {
    if (booking.paymentStatus !== BookingPaymentStatus.PAID) {
      return { amount: 0n, txId: null };
    }
    const amount = BigInt(booking.totalAmount);
    if (amount <= 0n) {
      return { amount: 0n, txId: null };
    }

    const wallet = await manager.getRepository(Wallet).findOne({
      where: { userId: booking.passengerId },
    });
    if (!wallet) {
      this.logger.warn(
        `Admin cancel refund skipped: no wallet for passenger ${booking.passengerId}`,
      );
      return { amount: 0n, txId: null };
    }

    const parent =
      booking.fareWalletTransactionId ?? booking.walletTransactionId ?? null;
    const result = await this.walletService.creditPointsInTransaction(manager, {
      walletId: wallet.id,
      userId: booking.passengerId,
      amount,
      sourceType: WalletPointSource.PURCHASED,
      transactionType: WalletTransactionType.REFUND,
      referenceType: 'BOOKING',
      referenceId: booking.id,
      parentTransactionId: parent,
      idempotencyKey: adminRideRefundKey(ride.id, booking.id),
      suppressWalletCreditNotification: true,
    });
    return {
      amount: BigInt(result.transaction.amount),
      txId: result.transaction.id,
    };
  }

  private async releaseAssuredHolds(
    manager: EntityManager,
    ride: Ride,
    bookings: Booking[],
  ): Promise<{
    amount: bigint;
    txIds: string[];
    byBookingId: Map<string, bigint>;
  }> {
    const empty = {
      amount: 0n,
      txIds: [] as string[],
      byBookingId: new Map<string, bigint>(),
    };
    if (ride.rideType !== RideType.ASSURED) {
      return empty;
    }

    const holdIds = [
      ride.driverDepositHoldId,
      ...bookings.map((booking) => booking.walletHoldId),
    ].filter((id): id is string => Boolean(id));

    const orClauses: Array<{
      referenceType: string;
      referenceId: string;
      status: WalletHoldStatus;
    }> = [
      {
        referenceType: ASSURED_RIDE_DRIVER_DEPOSIT_REF,
        referenceId: ride.id,
        status: WalletHoldStatus.ACTIVE,
      },
      ...bookings.map((booking) => ({
        referenceType: ASSURED_BOOKING_RIDER_DEPOSIT_REF,
        referenceId: booking.id,
        status: WalletHoldStatus.ACTIVE,
      })),
    ];

    const [byId, byRef] = await Promise.all([
      holdIds.length > 0
        ? manager.getRepository(WalletHold).find({ where: { id: In(holdIds) } })
        : Promise.resolve([] as WalletHold[]),
      manager.getRepository(WalletHold).find({ where: orClauses }),
    ]);

    const holdsById = new Map<string, WalletHold>();
    for (const hold of [...byId, ...byRef]) {
      holdsById.set(hold.id, hold);
    }

    let amount = 0n;
    const txIds: string[] = [];
    const byBookingId = new Map<string, bigint>();
    const bookingByHoldId = new Map<string, string>();
    for (const booking of bookings) {
      if (booking.walletHoldId) {
        bookingByHoldId.set(booking.walletHoldId, booking.id);
      }
    }

    for (const hold of holdsById.values()) {
      if (hold.status !== WalletHoldStatus.ACTIVE) {
        continue;
      }
      const released = await this.walletService.releaseHoldInTransaction(
        manager,
        {
          holdId: hold.id,
          idempotencyKey: adminRideHoldReleaseKey(hold.id),
        },
      );
      amount += BigInt(hold.amount);
      if (released.transaction?.id) {
        txIds.push(released.transaction.id);
      }
      const bookingId =
        bookingByHoldId.get(hold.id) ??
        (hold.referenceType === ASSURED_BOOKING_RIDER_DEPOSIT_REF
          ? hold.referenceId
          : null);
      if (bookingId) {
        byBookingId.set(
          bookingId,
          (byBookingId.get(bookingId) ?? 0n) + BigInt(hold.amount),
        );
      }
    }
    return { amount, txIds, byBookingId };
  }

  private restoreReservedSeats(ride: Ride, booking: Booking): void {
    const reserved =
      ride.rideType === RideType.COMMUTE
        ? booking.status === BookingStatus.CONFIRMED
        : booking.status === BookingStatus.PENDING ||
          booking.status === BookingStatus.CONFIRMED;
    if (!reserved) {
      return;
    }
    ride.availableSeats = Math.min(
      ride.totalSeats,
      ride.availableSeats + booking.seats,
    );
  }

  private async resolveTargets(
    manager: EntityManager,
    ride: Ride,
    scope: SeriesScope,
  ): Promise<Ride[]> {
    if (scope !== SeriesScope.THIS_AND_FUTURE || !ride.seriesId) {
      return [ride];
    }
    const occurrenceDate = ride.occurrenceDate ?? ride.departureDate;
    return manager
      .getRepository(Ride)
      .createQueryBuilder('ride')
      .setLock('pessimistic_write')
      .where('ride.series_id = :seriesId', { seriesId: ride.seriesId })
      .andWhere('ride.occurrence_date >= CAST(:occurrenceDate AS date)', {
        occurrenceDate,
      })
      .orderBy('ride.occurrence_date', 'ASC')
      .addOrderBy('ride.departure_time', 'ASC')
      .addOrderBy('ride.id', 'ASC')
      .getMany();
  }

  private async lockRide(
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
      throw new NotFoundException({
        statusCode: 404,
        code: 'ADMIN_RIDE_NOT_FOUND',
        message: 'Ride not found',
        error: 'NotFound',
      });
    }
    return ride;
  }

  private notifyPassengersFromAudit(
    audit: AdminRideCancellation,
  ): Array<{ bookingId: string; passengerId: string }> {
    return (audit.bookings ?? []).map((row) => ({
      bookingId: row.bookingId,
      passengerId: row.passengerId,
    }));
  }

  private collectedAmount(booking: Booking): string {
    if (booking.paymentStatus === BookingPaymentStatus.UNPAID) {
      return '0';
    }
    return booking.totalAmount;
  }

  private async dispatchSideEffects(effect: {
    rideId: string;
    inProgress: boolean;
    driverId: string;
    passengers: Array<{ bookingId: string; passengerId: string }>;
  }): Promise<void> {
    this.trackingService.broadcastRideCancelled({
      rideId: effect.rideId,
      finalStatus: RideStatus.CANCELLED,
      reason: RideCancellationReason.ADMIN_CANCELLED,
      inProgress: effect.inProgress,
      bookingIds: effect.passengers.map((row) => row.bookingId),
    });
    await this.trackingService.clearRideTracking(effect.rideId, 'cancel');
    await this.chatService.safeCloseForRide(effect.rideId);

    const driverBody = effect.inProgress
      ? ADMIN_OPS_DRIVER_CANCEL_BODY
      : ADMIN_PRETRIP_DRIVER_CANCEL_BODY;
    const passengerBody = effect.inProgress
      ? ADMIN_OPS_PASSENGER_CANCEL_BODY
      : ADMIN_PRETRIP_PASSENGER_CANCEL_BODY;

    await this.notificationsService.safeNotifyAdminRideCancelled({
      rideId: effect.rideId,
      recipientUserId: effect.driverId,
      role: 'driver',
      body: driverBody,
      inProgress: effect.inProgress,
      cancellationReason: 'ADMIN_CANCELLED',
    });
    for (const passenger of effect.passengers) {
      await this.notificationsService.safeNotifyAdminRideCancelled({
        rideId: effect.rideId,
        bookingId: passenger.bookingId,
        recipientUserId: passenger.passengerId,
        role: 'passenger',
        body: passengerBody,
        inProgress: effect.inProgress,
        cancellationReason: 'ADMIN_CANCELLED',
      });
    }
  }

  private toOccurrenceDto(
    audit: AdminRideCancellation,
    alreadyApplied: boolean,
  ): AdminCancelOccurrenceResultDto {
    return {
      rideId: audit.rideId,
      rideType: audit.rideType,
      previousStatus: audit.previousStatus,
      finalStatus: audit.finalStatus,
      cancellationReason: audit.reason,
      adminUserId: audit.adminUserId,
      cancelledAt: audit.createdAt.toISOString(),
      seriesScope: audit.seriesScope,
      bookings: audit.bookings,
      refundTotal: audit.refundTotal,
      depositReleaseTotal: audit.depositReleaseTotal,
      compensationTotal: audit.compensationTotal,
      supportEscalationRequired: audit.supportEscalationRequired,
      alreadyApplied,
      financialTransactionIds: audit.financialTransactionIds,
    };
  }

  private toExistingCancelDto(
    ride: Ride,
    params: {
      admin: AdminUser;
      reason: string;
      seriesScope: SeriesScope | null;
    },
  ): AdminCancelOccurrenceResultDto {
    return {
      rideId: ride.id,
      rideType: ride.rideType,
      previousStatus: RideStatus.CANCELLED,
      finalStatus: RideStatus.CANCELLED,
      cancellationReason: ride.cancellationReason ?? 'CANCELLED',
      adminUserId: params.admin.id,
      cancelledAt: ride.cancelledAt?.toISOString() ?? new Date().toISOString(),
      seriesScope: params.seriesScope,
      bookings: [],
      refundTotal: '0',
      depositReleaseTotal: '0',
      compensationTotal: '0',
      supportEscalationRequired: false,
      alreadyApplied: true,
      financialTransactionIds: [],
    };
  }

  private toSkippedDto(
    ride: Ride,
    params: { admin: AdminUser; seriesScope: SeriesScope | null },
    status: RideStatus,
  ): AdminCancelOccurrenceResultDto {
    return {
      rideId: ride.id,
      rideType: ride.rideType,
      previousStatus: status,
      finalStatus: status,
      cancellationReason: 'SKIPPED',
      adminUserId: params.admin.id,
      cancelledAt: new Date().toISOString(),
      seriesScope: params.seriesScope,
      bookings: [],
      refundTotal: '0',
      depositReleaseTotal: '0',
      compensationTotal: '0',
      supportEscalationRequired: false,
      alreadyApplied: true,
      financialTransactionIds: [],
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const driverError = error.driverError as { code?: string };
    return driverError?.code === '23505';
  }
}
