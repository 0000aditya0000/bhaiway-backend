import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';

import { AssuredLifecycleService } from '../assured/assured-lifecycle.service';
import { CommuteCancellationService } from '../bookings/commute-cancellation.service';
import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingCancellationReason,
  BookingMode,
  BookingPickupStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { ChatService } from '../chat/chat.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Ride } from '../rides/entities/ride.entity';
import {
  RideCancellationReason,
  RideStatus,
  RideType,
} from '../rides/enums/ride.enums';
import { RegularRideCancellationService } from '../rides/regular-ride-cancellation.service';
import { CreateSupportTicketDto } from '../support/dto/create-support-ticket.dto';
import {
  SupportBookingsSubcategory,
  SupportTicketCategory,
} from '../support/enums/support.enums';
import { SupportService } from '../support/support.service';
import { TrackingService } from '../tracking/tracking.service';
import {
  NoShowClaimEffectDto,
  NoShowClaimResponseDto,
} from './dto/no-show-claim-response.dto';
import { NoShowClaimEffect } from './entities/no-show-claim-effect.entity';
import { NoShowClaim } from './entities/no-show-claim.entity';
import {
  NoShowClaimEffectKind,
  NoShowClaimEffectStatus,
  NoShowClaimKind,
  NoShowClaimStatus,
  NoShowDecisionSource,
} from './enums/no-show.enums';
import {
  NO_SHOW_EFFECT_MAX_ATTEMPTS,
  NO_SHOW_EFFECT_RETRY_BASE_MS,
  NO_SHOW_RESPONSE_WINDOW_MS,
  NO_SHOW_WORKER_BATCH_SIZE,
} from './no-show.constants';
import { NoShowClaimAlreadyRejectedError } from './errors/no-show.errors';
import { isNoShowEligible } from './no-show-timing';

type ResolveSource = NoShowDecisionSource;

interface SettlementSideEffects {
  closeRideChat?: string;
  closeBookingChat?: string;
  clearTracking?: string;
  regularCancelled?: Array<{ bookingId: string; passengerId: string }>;
  commuteCancelled?: Array<{ bookingId: string; passengerId: string }>;
  assuredForfeit?: {
    rideId: string;
    alreadyApplied: boolean;
    promotedRide?: Ride | null;
    cancelledBookings?: Array<{
      bookingId: string;
      passengerId: string;
      bookingMode: BookingMode;
    }>;
  };
}

@Injectable()
export class NoShowClaimsService {
  private readonly logger = new Logger(NoShowClaimsService.name);
  private dueClaimsInFlight: Promise<number> | null = null;
  private pendingEffectsInFlight: Promise<number> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(NoShowClaim)
    private readonly claimRepository: Repository<NoShowClaim>,
    @InjectRepository(NoShowClaimEffect)
    private readonly effectRepository: Repository<NoShowClaimEffect>,
    private readonly regularRideCancellationService: RegularRideCancellationService,
    private readonly assuredLifecycleService: AssuredLifecycleService,
    @Inject(forwardRef(() => CommuteCancellationService))
    private readonly commuteCancellationService: CommuteCancellationService,
    private readonly notificationsService: NotificationsService,
    private readonly supportService: SupportService,
    private readonly chatService: ChatService,
    private readonly trackingService: TrackingService,
  ) {}

  async reportDriverDidNotCome(
    passengerId: string,
    rideId: string,
  ): Promise<NoShowClaimResponseDto> {
    const claim = await this.createClaim({
      actorUserId: passengerId,
      kind: NoShowClaimKind.DRIVER_NO_SHOW,
      rideId,
      bookingId: null,
    });
    if (!claim.alreadyOpen) {
      await this.notificationsService.safeNotifyNoShowClaimOpened({
        claimId: claim.id,
        rideId: claim.rideId,
        bookingId: claim.bookingId,
        recipientUserId: claim.respondentUserId,
        kind: claim.kind,
      });
    }
    return claim;
  }

  async reportPassengerDidNotCome(
    driverId: string,
    bookingId: string,
  ): Promise<NoShowClaimResponseDto> {
    const claim = await this.createClaim({
      actorUserId: driverId,
      kind: NoShowClaimKind.PASSENGER_NO_SHOW,
      rideId: null,
      bookingId,
    });
    if (!claim.alreadyOpen) {
      await this.notificationsService.safeNotifyNoShowClaimOpened({
        claimId: claim.id,
        rideId: claim.rideId,
        bookingId: claim.bookingId,
        recipientUserId: claim.respondentUserId,
        kind: claim.kind,
      });
    }
    return claim;
  }

  async getClaim(
    userId: string,
    claimId: string,
  ): Promise<NoShowClaimResponseDto> {
    const claim = await this.claimRepository.findOne({ where: { id: claimId } });
    if (!claim) {
      throw new NotFoundException('No-Show claim not found');
    }
    if (
      claim.claimantUserId !== userId &&
      claim.respondentUserId !== userId
    ) {
      throw new NotFoundException('No-Show claim not found');
    }
    return this.toResponse(
      claim,
      false,
      false,
      await this.loadEffects(claim.id),
    );
  }

  async approve(
    userId: string,
    claimId: string,
  ): Promise<NoShowClaimResponseDto> {
    return this.resolveClaim(claimId, {
      source: NoShowDecisionSource.RESPONDENT,
      actorUserId: userId,
      action: 'approve',
    });
  }

  async reject(
    userId: string,
    claimId: string,
  ): Promise<NoShowClaimResponseDto> {
    return this.resolveClaim(claimId, {
      source: NoShowDecisionSource.RESPONDENT,
      actorUserId: userId,
      action: 'reject',
    });
  }

  /** Public for tests and the polling worker. */
  async processDueClaims(): Promise<number> {
    if (this.dueClaimsInFlight) {
      return this.dueClaimsInFlight;
    }
    this.dueClaimsInFlight = this.drainDueClaims().finally(() => {
      this.dueClaimsInFlight = null;
    });
    return this.dueClaimsInFlight;
  }

  /**
   * Drain due claims without the in-process in-flight guard. Used to simulate
   * another backend instance sharing the same database (each process has its
   * own mutex). Safety is the ride→claim SKIP LOCKED locking in resolveClaim.
   */
  async processDueClaimsConcurrent(): Promise<number> {
    return this.drainDueClaims();
  }

  /** Public for tests and the polling worker. */
  async processPendingEffects(claimId?: string): Promise<number> {
    if (claimId) {
      return this.drainPendingEffects(claimId);
    }
    if (this.pendingEffectsInFlight) {
      return this.pendingEffectsInFlight;
    }
    this.pendingEffectsInFlight = this.drainPendingEffects().finally(() => {
      this.pendingEffectsInFlight = null;
    });
    return this.pendingEffectsInFlight;
  }

  /**
   * Candidate IDs are selected without row locks so we can lock ride then claim
   * (the shared No-Show lock order). Timeout settlement then takes the claim
   * with FOR UPDATE SKIP LOCKED after the ride lock. Settlement itself is
   * serialized by those row locks, so a failed attempt can be retried without
   * paying twice.
   */
  private async drainDueClaims(): Promise<number> {
    const due = await this.claimRepository
      .createQueryBuilder('claim')
      .select(['claim.id'])
      .where('claim.status = :status', { status: NoShowClaimStatus.PENDING })
      .andWhere('claim.respondBy <= :now', { now: new Date() })
      .orderBy('claim.respondBy', 'ASC')
      .addOrderBy('claim.id', 'ASC')
      .take(NO_SHOW_WORKER_BATCH_SIZE)
      .getMany();

    let settled = 0;
    for (const row of due) {
      try {
        const result = await this.resolveClaim(row.id, {
          source: NoShowDecisionSource.TIMEOUT,
          actorUserId: null,
          action: 'approve',
          skipLocked: true,
        });
        if (
          result.status === NoShowClaimStatus.APPROVED &&
          result.decisionSource === NoShowDecisionSource.TIMEOUT
        ) {
          settled += 1;
        }
      } catch (error) {
        this.logger.warn(
          `No-Show timeout settle failed claim=${row.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return settled;
  }

  private async drainPendingEffects(claimId?: string): Promise<number> {
    const due = this.effectRepository
      .createQueryBuilder('effect')
      .select(['effect.id'])
      .where('effect.status = :status', {
        status: NoShowClaimEffectStatus.PENDING,
      })
      .andWhere('effect.attemptCount < :maxAttempts', {
        maxAttempts: NO_SHOW_EFFECT_MAX_ATTEMPTS,
      })
      .andWhere(
        '(effect.nextAttemptAt IS NULL OR effect.nextAttemptAt <= :now)',
        { now: new Date() },
      )
      .orderBy('effect.nextAttemptAt', 'ASC')
      .addOrderBy('effect.id', 'ASC')
      .take(NO_SHOW_WORKER_BATCH_SIZE);
    if (claimId) {
      due.andWhere('effect.claimId = :claimId', { claimId });
    }
    const rows = await due.getMany();

    let completed = 0;
    for (const row of rows) {
      try {
        if (await this.processOneEffect(row.id)) {
          completed += 1;
        }
      } catch (error) {
        this.logger.warn(
          `No-Show post-commit effect failed id=${row.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return completed;
  }

  private async createClaim(params: {
    actorUserId: string;
    kind: NoShowClaimKind;
    rideId: string | null;
    bookingId: string | null;
  }): Promise<NoShowClaimResponseDto> {
    try {
      const saved = await this.dataSource.transaction(async (manager) => {
        let ride: Ride;
        let reporterBooking: Booking | null = null;

        if (params.kind === NoShowClaimKind.PASSENGER_NO_SHOW) {
          if (!params.bookingId) {
            throw new BadRequestException('Booking is required');
          }
          const bookingPeek = await manager.getRepository(Booking).findOne({
            where: { id: params.bookingId },
          });
          if (!bookingPeek) {
            throw new NotFoundException('Booking not found');
          }
          const lockedRide = await this.lockRide(manager, bookingPeek.rideId);
          if (!lockedRide) {
            throw new NotFoundException('Ride not found');
          }
          ride = lockedRide;
          reporterBooking = await this.lockBooking(manager, params.bookingId);
          if (!reporterBooking) {
            throw new NotFoundException('Booking not found');
          }
        } else {
          if (!params.rideId) {
            throw new BadRequestException('Ride is required');
          }
          const locked = await this.lockRide(manager, params.rideId);
          if (!locked) {
            throw new NotFoundException('Ride not found');
          }
          ride = locked;
          if (
            ride.status === RideStatus.CANCELLED ||
            ride.status === RideStatus.COMPLETED
          ) {
            throw new ConflictException(
              `No-Show cannot be reported when the ride is ${ride.status}`,
            );
          }
          const reporterPeek = await this.findReporterBookingForDriverClaim(
            manager,
            ride,
            params.actorUserId,
          );
          reporterBooking = await this.lockBooking(manager, reporterPeek.id);
          if (!reporterBooking) {
            throw new NotFoundException('Ride not found');
          }
        }

        const { claimantUserId, respondentUserId, bookingId } =
          this.assertCanCreateClaim({
            actorUserId: params.actorUserId,
            kind: params.kind,
            ride,
            booking: reporterBooking,
          });

        const existing = await this.findOpenDuplicate(
          manager,
          params.kind,
          ride.id,
          bookingId,
        );
        if (existing) {
          return { claim: existing, alreadyOpen: true };
        }

        await this.assertNotPreviouslyRejected(
          manager,
          params.kind,
          ride.id,
          bookingId,
        );

        const now = new Date();
        const claim = manager.getRepository(NoShowClaim).create({
          id: randomUUID(),
          rideId: ride.id,
          bookingId,
          rideType: ride.rideType,
          kind: params.kind,
          claimantUserId,
          respondentUserId,
          status: NoShowClaimStatus.PENDING,
          respondBy: new Date(now.getTime() + NO_SHOW_RESPONSE_WINDOW_MS),
        });
        const inserted = await manager.getRepository(NoShowClaim).save(claim);
        return { claim: inserted, alreadyOpen: false };
      });
      return this.toResponse(saved.claim, saved.alreadyOpen);
    } catch (error) {
      if (this.isPendingUniqueViolation(error)) {
        const recovered = await this.recoverDuplicatePending(params);
        if (recovered) {
          return this.toResponse(recovered, true);
        }
      }
      throw error;
    }
  }

  private assertCanCreateClaim(params: {
    actorUserId: string;
    kind: NoShowClaimKind;
    ride: Ride;
    booking: Booking | null;
  }): {
    claimantUserId: string;
    respondentUserId: string;
    bookingId: string | null;
  } {
    const { actorUserId, kind, ride, booking } = params;
    const now = new Date();

    if (
      ride.status === RideStatus.CANCELLED ||
      ride.status === RideStatus.COMPLETED
    ) {
      throw new ConflictException(
        `No-Show cannot be reported when the ride is ${ride.status}`,
      );
    }

    if (!isNoShowEligible(now, ride.departureDate, ride.departureTime)) {
      throw new ConflictException(
        'No-Show can be reported 5 minutes after scheduled departure',
      );
    }

    if (kind === NoShowClaimKind.DRIVER_NO_SHOW) {
      if (ride.driverId === actorUserId) {
        throw new NotFoundException('Ride not found');
      }

      const eligibleBooking = this.assertReporterBooking(ride, booking, actorUserId);
      if (eligibleBooking.pickupStatus === BookingPickupStatus.PICKED_UP) {
        throw new ConflictException(
          'Driver No-Show cannot be reported after pickup',
        );
      }
      return {
        claimantUserId: actorUserId,
        respondentUserId: ride.driverId,
        bookingId: eligibleBooking.id,
      };
    }

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (ride.driverId !== actorUserId) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.rideId !== ride.id) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new ConflictException(
        'Passenger No-Show requires a CONFIRMED booking',
      );
    }
    if (ride.rideType === RideType.COMMUTE && booking.status !== BookingStatus.CONFIRMED) {
      throw new ConflictException(
        'Passenger No-Show cannot be reported against a pending Commute request',
      );
    }
    if (booking.pickupStatus === BookingPickupStatus.PICKED_UP) {
      throw new ConflictException(
        'Passenger No-Show cannot be reported after pickup',
      );
    }
    if (
      ride.rideType === RideType.ASSURED &&
      booking.bookingMode !== BookingMode.ASSURED
    ) {
      throw new BadRequestException(
        'Assured passenger No-Show applies only to Assured-mode bookings',
      );
    }
    if (
      ride.rideType === RideType.REGULAR &&
      booking.bookingMode !== BookingMode.REGULAR
    ) {
      throw new BadRequestException(
        'Regular passenger No-Show applies only to Regular-mode bookings',
      );
    }
    if (
      ride.rideType === RideType.COMMUTE &&
      booking.bookingMode !== BookingMode.COMMUTE
    ) {
      throw new BadRequestException(
        'Commute passenger No-Show applies only to Commute bookings',
      );
    }

    return {
      claimantUserId: actorUserId,
      respondentUserId: booking.passengerId,
      bookingId: booking.id,
    };
  }

  private async findReporterBookingForDriverClaim(
    manager: EntityManager,
    ride: Ride,
    passengerId: string,
  ): Promise<Booking> {
    const bookings = await manager.getRepository(Booking).find({
      where: { rideId: ride.id, passengerId },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    const candidate =
      bookings.find((row) => {
        if (ride.rideType === RideType.ASSURED) {
          return (
            row.bookingMode === BookingMode.ASSURED &&
            (row.status === BookingStatus.PENDING ||
              row.status === BookingStatus.CONFIRMED)
          );
        }
        return (
          row.status === BookingStatus.CONFIRMED ||
          row.status === BookingStatus.PENDING
        );
      }) ?? null;
    return this.assertReporterBooking(ride, candidate, passengerId);
  }

  private assertReporterBooking(
    ride: Ride,
    booking: Booking | null,
    passengerId: string,
  ): Booking {
    if (!booking || booking.passengerId !== passengerId || booking.rideId !== ride.id) {
      throw new NotFoundException('Ride not found');
    }
    if (ride.rideType === RideType.ASSURED) {
      if (booking.bookingMode !== BookingMode.ASSURED) {
        throw new NotFoundException('Ride not found');
      }
      if (
        booking.status !== BookingStatus.PENDING &&
        booking.status !== BookingStatus.CONFIRMED
      ) {
        throw new NotFoundException('Ride not found');
      }
      return booking;
    }
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new ConflictException(
        ride.rideType === RideType.COMMUTE
          ? 'No-Show cannot be reported against a pending Commute request'
          : 'Driver No-Show requires a CONFIRMED booking',
      );
    }
    if (ride.rideType === RideType.COMMUTE && booking.bookingMode !== BookingMode.COMMUTE) {
      throw new NotFoundException('Ride not found');
    }
    if (ride.rideType === RideType.REGULAR && booking.bookingMode !== BookingMode.REGULAR) {
      throw new NotFoundException('Ride not found');
    }
    return booking;
  }

  private async resolveClaim(
    claimId: string,
    params: {
      source: ResolveSource;
      actorUserId: string | null;
      action: 'approve' | 'reject';
      skipLocked?: boolean;
    },
  ): Promise<NoShowClaimResponseDto> {
    const peek = await this.claimRepository.findOne({ where: { id: claimId } });
    if (!peek) {
      throw new NotFoundException('No-Show claim not found');
    }
    this.assertRespondentCanResolve(peek, params);

    const { claim, sideEffects, notify, skipped } =
      await this.dataSource.transaction(async (manager) => {
        const result = await (async () => {
        const ride = await this.lockRide(manager, peek.rideId);
        if (!ride) {
          throw new NotFoundException('Ride not found');
        }

        const claim = await this.lockClaim(manager, claimId, {
          skipLocked: params.skipLocked === true,
        });
        if (!claim) {
          if (params.skipLocked) {
            return {
              claim: peek,
              sideEffects: {} as SettlementSideEffects,
              notify: null as 'approved' | 'rejected' | 'timeout' | null,
              skipped: true,
            };
          }
          throw new NotFoundException('No-Show claim not found');
        }

        this.assertRespondentCanResolve(claim, params);

        if (claim.status !== NoShowClaimStatus.PENDING) {
          if (
            params.action === 'approve' &&
            claim.status === NoShowClaimStatus.APPROVED
          ) {
            return {
              claim,
              sideEffects: {} as SettlementSideEffects,
              notify:
                claim.decisionSource === NoShowDecisionSource.TIMEOUT
                  ? ('timeout' as const)
                  : ('approved' as const),
              skipped: false,
            };
          }
          if (
            params.action === 'reject' &&
            claim.status === NoShowClaimStatus.REJECTED
          ) {
            return {
              claim,
              sideEffects: {} as SettlementSideEffects,
              notify: 'rejected' as const,
              skipped: false,
            };
          }
          throw new ConflictException(
            `No-Show claim is already ${claim.status}`,
          );
        }

        if (params.source === NoShowDecisionSource.TIMEOUT) {
          if (claim.respondBy.getTime() > Date.now()) {
            return {
              claim,
              sideEffects: {} as SettlementSideEffects,
              notify: null as 'approved' | 'rejected' | 'timeout' | null,
              skipped: false,
            };
          }
        }

        const now = new Date();
        if (params.action === 'reject') {
          claim.status = NoShowClaimStatus.REJECTED;
          claim.decisionSource = params.source;
          claim.respondedAt = now;
          claim.respondedByUserId = params.actorUserId;
          await manager.getRepository(NoShowClaim).save(claim);
          return {
            claim,
            sideEffects: {} as SettlementSideEffects,
            notify: 'rejected' as const,
            skipped: false,
          };
        }

        let lockedBooking: Booking | null = null;
        if (claim.bookingId) {
          lockedBooking = await this.lockBooking(manager, claim.bookingId);
        }

        const guard = await this.settlementGuard(
          manager,
          claim,
          ride,
          lockedBooking,
        );
        if (guard.terminalStatus) {
          if (
            guard.terminalStatus === NoShowClaimStatus.REJECTED &&
            lockedBooking?.pickupStatus === BookingPickupStatus.PICKED_UP
          ) {
            this.logger.log(
              `${claim.kind} claim=${claim.id} REJECTED: booking=${claim.bookingId} already picked up`,
            );
          }
          claim.status = guard.terminalStatus;
          claim.decisionSource = params.source;
          claim.respondedAt = now;
          claim.respondedByUserId =
            params.source === NoShowDecisionSource.RESPONDENT
              ? params.actorUserId
              : null;
          await manager.getRepository(NoShowClaim).save(claim);
          return {
            claim,
            sideEffects: {} as SettlementSideEffects,
            notify:
              guard.terminalStatus === NoShowClaimStatus.REJECTED
                ? ('rejected' as const)
                : null,
            skipped: false,
          };
        }

        const sideEffects = await this.settleApproved(manager, claim, ride);
        claim.status = NoShowClaimStatus.APPROVED;
        claim.decisionSource = params.source;
        claim.respondedAt = now;
        claim.respondedByUserId =
          params.source === NoShowDecisionSource.RESPONDENT
            ? params.actorUserId
            : null;
        claim.settledAt = now;
        claim.settlementIdempotencyKey = `no-show-settle:${claim.id}`;
        await manager.getRepository(NoShowClaim).save(claim);

        if (claim.kind === NoShowClaimKind.DRIVER_NO_SHOW) {
          await this.supersedePendingPassengerClaims(manager, ride.id, claim.id);
        }

        const notify =
          params.source === NoShowDecisionSource.TIMEOUT
            ? ('timeout' as const)
            : ('approved' as const);
        return { claim, sideEffects, notify, skipped: false };
        })();
        if (!result.skipped) {
          await this.queueResolutionEffects(manager, result.claim, result.notify);
        }
        return result;
      });

    if (skipped) {
      return this.toResponse(claim, false, false, []);
    }

    await this.runSideEffects(sideEffects);
    await this.processPendingEffects(claim.id);

    const fresh = await this.claimRepository.findOneByOrFail({ id: claim.id });
    return this.toResponse(
      fresh,
      false,
      notify === 'rejected',
      await this.loadEffects(fresh.id),
    );
  }

  private assertRespondentCanResolve(
    claim: NoShowClaim,
    params: {
      source: ResolveSource;
      actorUserId: string | null;
    },
  ): void {
    if (params.source !== NoShowDecisionSource.RESPONDENT) {
      return;
    }
    if (!params.actorUserId || params.actorUserId !== claim.respondentUserId) {
      throw new NotFoundException('No-Show claim not found');
    }
  }

  private async settlementGuard(
    _manager: EntityManager,
    claim: NoShowClaim,
    ride: Ride,
    lockedBooking: Booking | null,
  ): Promise<{ terminalStatus: NoShowClaimStatus | null }> {
    if (claim.kind === NoShowClaimKind.DRIVER_NO_SHOW) {
      if (ride.status === RideStatus.COMPLETED) {
        return { terminalStatus: NoShowClaimStatus.REJECTED };
      }
      if (ride.status === RideStatus.CANCELLED) {
        return { terminalStatus: NoShowClaimStatus.SUPERSEDED };
      }
      if (lockedBooking?.pickupStatus === BookingPickupStatus.PICKED_UP) {
        return { terminalStatus: NoShowClaimStatus.REJECTED };
      }
      return { terminalStatus: null };
    }

    if (!claim.bookingId) {
      return { terminalStatus: NoShowClaimStatus.SUPERSEDED };
    }
    const booking = lockedBooking;
    if (!booking) {
      return { terminalStatus: NoShowClaimStatus.SUPERSEDED };
    }
    if (booking.pickupStatus === BookingPickupStatus.PICKED_UP) {
      return { terminalStatus: NoShowClaimStatus.REJECTED };
    }
    if (
      booking.status === BookingStatus.CANCELLED ||
      booking.status === BookingStatus.COMPLETED ||
      ride.status === RideStatus.CANCELLED ||
      ride.status === RideStatus.COMPLETED
    ) {
      return { terminalStatus: NoShowClaimStatus.SUPERSEDED };
    }
    return { terminalStatus: null };
  }

  private async settleApproved(
    manager: EntityManager,
    claim: NoShowClaim,
    ride: Ride,
  ): Promise<SettlementSideEffects> {
    if (claim.kind === NoShowClaimKind.DRIVER_NO_SHOW) {
      if (ride.rideType === RideType.REGULAR) {
        const result =
          await this.regularRideCancellationService.cancelRideInTransaction(
            manager,
            {
              rideId: ride.id,
              cancelledByUserId: claim.claimantUserId,
              requireDriverOwnership: false,
              rideCancellationReason: RideCancellationReason.DRIVER_NO_SHOW,
              bookingCancellationReason:
                BookingCancellationReason.DRIVER_NO_SHOW,
            },
          );
        return {
          closeRideChat: ride.id,
          clearTracking: ride.id,
          regularCancelled: result.alreadyApplied
            ? []
            : result.cancelledBookings,
        };
      }
      if (ride.rideType === RideType.ASSURED) {
        const result =
          await this.assuredLifecycleService.settleDriverNoShowInTransaction(
            manager,
            claim.claimantUserId,
            ride.id,
          );
        return {
          closeRideChat: ride.id,
          clearTracking: ride.id,
          assuredForfeit: result,
        };
      }
      if (ride.rideType === RideType.COMMUTE) {
        const result =
          await this.commuteCancellationService.settleDriverNoShowInTransaction(
            manager,
            {
              rideId: ride.id,
              cancelledByUserId: claim.claimantUserId,
            },
          );
        return {
          closeRideChat: ride.id,
          clearTracking: ride.id,
          commuteCancelled: result.cancelledForNotify,
        };
      }
      throw new BadRequestException(`Unsupported ride type: ${ride.rideType}`);
    }

    if (!claim.bookingId) {
      throw new ConflictException('Passenger No-Show claim is missing a booking');
    }

    if (ride.rideType === RideType.REGULAR) {
      await this.regularRideCancellationService.cancelBookingInTransaction(
        manager,
        {
          bookingId: claim.bookingId,
          cancellationReason: BookingCancellationReason.RIDER_NO_SHOW,
        },
      );
      return { closeBookingChat: claim.bookingId };
    }
    if (ride.rideType === RideType.ASSURED) {
      await this.assuredLifecycleService.settleRiderNoShowInTransaction(
        manager,
        ride.driverId,
        claim.bookingId,
      );
      return { closeBookingChat: claim.bookingId };
    }
    if (ride.rideType === RideType.COMMUTE) {
      await this.commuteCancellationService.settlePassengerNoShowInTransaction(
        manager,
        { bookingId: claim.bookingId, driverId: ride.driverId },
      );
      return { closeBookingChat: claim.bookingId };
    }
    throw new BadRequestException(`Unsupported ride type: ${ride.rideType}`);
  }

  private async supersedePendingPassengerClaims(
    manager: EntityManager,
    rideId: string,
    driverClaimId: string,
  ): Promise<void> {
    const pending = await manager
      .getRepository(NoShowClaim)
      .createQueryBuilder('claim')
      .setLock('pessimistic_write')
      .where('claim.rideId = :rideId', { rideId })
      .andWhere('claim.kind = :kind', {
        kind: NoShowClaimKind.PASSENGER_NO_SHOW,
      })
      .andWhere('claim.status = :status', { status: NoShowClaimStatus.PENDING })
      .andWhere('claim.id != :driverClaimId', { driverClaimId })
      .orderBy('claim.id', 'ASC')
      .getMany();

    const now = new Date();
    for (const other of pending) {
      other.status = NoShowClaimStatus.SUPERSEDED;
      other.respondedAt = now;
      other.decisionSource = null;
      await manager.getRepository(NoShowClaim).save(other);
    }
  }

  private async runSideEffects(effects: SettlementSideEffects): Promise<void> {
    if (effects.closeRideChat) {
      await this.chatService.safeCloseForRide(effects.closeRideChat);
    }
    if (effects.closeBookingChat) {
      await this.chatService.safeCloseForBooking(effects.closeBookingChat);
    }
    if (effects.clearTracking) {
      await this.trackingService.clearRideTracking(effects.clearTracking, 'cancel');
    }
    if (effects.assuredForfeit) {
      await this.assuredLifecycleService.notifyAfterAssuredRideForfeit(
        effects.assuredForfeit,
      );
    }
    for (const booking of effects.regularCancelled ?? []) {
      await this.notificationsService.safeNotifyBookingCancelled({
        bookingId: booking.bookingId,
        rideId: effects.clearTracking ?? booking.bookingId,
        recipientUserId: booking.passengerId,
        bookingMode: 'REGULAR',
      });
    }
    for (const booking of effects.commuteCancelled ?? []) {
      await this.notificationsService.safeNotifyCommuteCancelled({
        bookingId: booking.bookingId,
        rideId: effects.clearTracking ?? booking.bookingId,
        recipientUserId: booking.passengerId,
      });
    }
  }

  private async queueResolutionEffects(
    manager: EntityManager,
    claim: NoShowClaim,
    notify: 'approved' | 'rejected' | 'timeout' | null,
  ): Promise<void> {
    if (notify) {
      await this.upsertPendingEffect(manager, {
        claimId: claim.id,
        kind: NoShowClaimEffectKind.NOTIFY_RESOLVED,
        payload: { resolution: notify },
      });
    }
    if (claim.status === NoShowClaimStatus.REJECTED) {
      if (!claim.supportTicketId) {
        await this.upsertPendingEffect(manager, {
          claimId: claim.id,
          kind: NoShowClaimEffectKind.OPEN_SUPPORT,
          payload: {},
          reopenIfComplete: true,
        });
      }
    }
  }

  private async upsertPendingEffect(
    manager: EntityManager,
    params: {
      claimId: string;
      kind: NoShowClaimEffectKind;
      payload: { resolution?: 'approved' | 'rejected' | 'timeout' };
      reopenIfComplete?: boolean;
    },
  ): Promise<void> {
    const repo = manager.getRepository(NoShowClaimEffect);
    const existing = await repo.findOne({
      where: { claimId: params.claimId, kind: params.kind },
    });
    if (existing) {
      if (existing.status === NoShowClaimEffectStatus.COMPLETED) {
        if (params.reopenIfComplete) {
          existing.status = NoShowClaimEffectStatus.PENDING;
          existing.nextAttemptAt = null;
          existing.completedAt = null;
          await repo.save(existing);
        }
        return;
      }
      if (existing.status === NoShowClaimEffectStatus.FAILED) {
        existing.status = NoShowClaimEffectStatus.PENDING;
        existing.nextAttemptAt = null;
        await repo.save(existing);
      }
      return;
    }
    await repo.save(
      repo.create({
        id: randomUUID(),
        claimId: params.claimId,
        kind: params.kind,
        status: NoShowClaimEffectStatus.PENDING,
        payload: params.payload,
        attemptCount: 0,
        nextAttemptAt: null,
        lastError: null,
        completedAt: null,
      }),
    );
  }

  private async processOneEffect(effectId: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const locked: Array<{ id: string }> = await manager.query(
        `SELECT id FROM no_show_claim_effects
         WHERE id = $1
           AND status = 'PENDING'
           AND attempt_count < $2
           AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         FOR UPDATE SKIP LOCKED`,
        [effectId, NO_SHOW_EFFECT_MAX_ATTEMPTS],
      );
      if (locked.length === 0) {
        return false;
      }
      const effect = await manager.getRepository(NoShowClaimEffect).findOne({
        where: { id: effectId },
      });
      if (!effect || effect.status !== NoShowClaimEffectStatus.PENDING) {
        return false;
      }
      const claim = await manager.getRepository(NoShowClaim).findOne({
        where: { id: effect.claimId },
      });
      if (!claim) {
        effect.status = NoShowClaimEffectStatus.FAILED;
        effect.lastError = 'Claim not found';
        effect.attemptCount += 1;
        await manager.getRepository(NoShowClaimEffect).save(effect);
        this.logger.warn(
          `No-Show effect=${effect.id} FAILED: claim ${effect.claimId} is missing`,
        );
        return false;
      }

      effect.attemptCount += 1;
      try {
        if (effect.kind === NoShowClaimEffectKind.NOTIFY_RESOLVED) {
          const resolution = effect.payload?.resolution;
          if (
            resolution !== 'approved' &&
            resolution !== 'rejected' &&
            resolution !== 'timeout'
          ) {
            throw new Error('NOTIFY_RESOLVED effect is missing resolution');
          }
          await this.notifyResolved(manager, claim, resolution);
        } else if (effect.kind === NoShowClaimEffectKind.OPEN_SUPPORT) {
          await this.openSupportForRejectedClaim(manager, claim);
        }
        effect.status = NoShowClaimEffectStatus.COMPLETED;
        effect.completedAt = new Date();
        effect.lastError = null;
        effect.nextAttemptAt = null;
        await manager.getRepository(NoShowClaimEffect).save(effect);
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        const terminal = effect.attemptCount >= NO_SHOW_EFFECT_MAX_ATTEMPTS;
        effect.status = terminal
          ? NoShowClaimEffectStatus.FAILED
          : NoShowClaimEffectStatus.PENDING;
        effect.lastError = message.slice(0, 500);
        effect.nextAttemptAt = new Date(
          Date.now() +
            NO_SHOW_EFFECT_RETRY_BASE_MS *
              2 ** Math.min(effect.attemptCount, 4),
        );
        await manager.getRepository(NoShowClaimEffect).save(effect);
        this.logger.warn(
          `No-Show ${effect.kind} effect=${effect.id} claim=${claim.id} attempt=${effect.attemptCount} ${
            terminal ? 'FAILED' : 'PENDING'
          } (claim status ${claim.status} was not reversed): ${message}`,
        );
        return false;
      }
    });
  }

  private async notifyResolved(
    manager: EntityManager,
    claim: NoShowClaim,
    resolution: 'approved' | 'rejected' | 'timeout',
  ): Promise<void> {
    const recipients = [claim.claimantUserId, claim.respondentUserId];
    for (const recipientUserId of recipients) {
      await this.notificationsService.enqueueNoShowClaimResolved(
        {
          claimId: claim.id,
          rideId: claim.rideId,
          bookingId: claim.bookingId,
          recipientUserId,
          kind: claim.kind,
          resolution,
        },
        manager,
      );
    }
  }

  private async openSupportForRejectedClaim(
    manager: EntityManager,
    claim: NoShowClaim,
  ): Promise<void> {
    const subcategory =
      claim.kind === NoShowClaimKind.DRIVER_NO_SHOW
        ? SupportBookingsSubcategory.DRIVER_BEHAVIOUR
        : SupportBookingsSubcategory.OTHER;
    const dto: CreateSupportTicketDto = {
      category: SupportTicketCategory.BOOKINGS_AND_RIDES,
      subcategory,
      description:
        'Your No-Show claim was rejected by the other party. No cancellation, refund, penalty, or compensation was applied. Please review this ride with BhaiWay Support.',
      relatedRideId: claim.rideId,
      idempotencyKey: `no-show-reject:${claim.id}`,
    };
    const ticket = await this.supportService.createTicket(
      claim.claimantUserId,
      dto,
    );
    await manager.getRepository(NoShowClaim).update(
      { id: claim.id },
      { supportTicketId: ticket.id },
    );
  }

  private async loadEffects(claimId: string): Promise<NoShowClaimEffect[]> {
    return this.effectRepository.find({
      where: { claimId },
      order: { kind: 'ASC', id: 'ASC' },
    });
  }

  private async assertNotPreviouslyRejected(
    manager: EntityManager,
    kind: NoShowClaimKind,
    rideId: string,
    bookingId: string | null,
  ): Promise<void> {
    if (kind === NoShowClaimKind.DRIVER_NO_SHOW) {
      const rejected = await manager.getRepository(NoShowClaim).findOne({
        where: {
          rideId,
          kind: NoShowClaimKind.DRIVER_NO_SHOW,
          status: NoShowClaimStatus.REJECTED,
        },
      });
      if (rejected) {
        throw new NoShowClaimAlreadyRejectedError(kind);
      }
      return;
    }
    if (!bookingId) {
      return;
    }
    const rejected = await manager.getRepository(NoShowClaim).findOne({
      where: {
        bookingId,
        kind: NoShowClaimKind.PASSENGER_NO_SHOW,
        status: NoShowClaimStatus.REJECTED,
      },
    });
    if (rejected) {
      throw new NoShowClaimAlreadyRejectedError(kind);
    }
  }

  private async findOpenDuplicate(
    manager: EntityManager,
    kind: NoShowClaimKind,
    rideId: string,
    bookingId: string | null,
  ): Promise<NoShowClaim | null> {
    if (kind === NoShowClaimKind.DRIVER_NO_SHOW) {
      return manager.getRepository(NoShowClaim).findOne({
        where: {
          rideId,
          kind: NoShowClaimKind.DRIVER_NO_SHOW,
          status: NoShowClaimStatus.PENDING,
        },
      });
    }
    if (!bookingId) {
      return null;
    }
    return manager.getRepository(NoShowClaim).findOne({
      where: {
        bookingId,
        kind: NoShowClaimKind.PASSENGER_NO_SHOW,
        status: NoShowClaimStatus.PENDING,
      },
    });
  }

  private async recoverDuplicatePending(params: {
    kind: NoShowClaimKind;
    rideId: string | null;
    bookingId: string | null;
  }): Promise<NoShowClaim | null> {
    if (params.kind === NoShowClaimKind.DRIVER_NO_SHOW && params.rideId) {
      return this.claimRepository.findOne({
        where: {
          rideId: params.rideId,
          kind: NoShowClaimKind.DRIVER_NO_SHOW,
          status: NoShowClaimStatus.PENDING,
        },
      });
    }
    if (params.kind === NoShowClaimKind.PASSENGER_NO_SHOW && params.bookingId) {
      return this.claimRepository.findOne({
        where: {
          bookingId: params.bookingId,
          kind: NoShowClaimKind.PASSENGER_NO_SHOW,
          status: NoShowClaimStatus.PENDING,
        },
      });
    }
    return null;
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

  private async lockClaim(
    manager: EntityManager,
    claimId: string,
    options: { skipLocked?: boolean } = {},
  ): Promise<NoShowClaim | null> {
    if (options.skipLocked) {
      const skipped: Array<{ id: string }> = await manager.query(
        `SELECT id FROM no_show_claims WHERE id = $1 FOR UPDATE SKIP LOCKED`,
        [claimId],
      );
      if (skipped.length === 0) {
        return null;
      }
    }
    return manager
      .getRepository(NoShowClaim)
      .createQueryBuilder('claim')
      .setLock('pessimistic_write')
      .where('claim.id = :claimId', { claimId })
      .getOne();
  }

  private isPendingUniqueViolation(error: unknown): boolean {
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
          (current instanceof QueryFailedError || code === '23505') &&
          (constraint.includes('pending_driver') ||
            constraint.includes('pending_passenger') ||
            constraint.includes('no_show_claims'))
        ) {
          return true;
        }
        current = record.cause ?? record.driverError;
        continue;
      }
      break;
    }
    return false;
  }

  private toResponse(
    claim: NoShowClaim,
    alreadyOpen: boolean,
    includeSupportHint = false,
    effects: NoShowClaimEffect[] = [],
  ): NoShowClaimResponseDto {
    const support =
      includeSupportHint || claim.status === NoShowClaimStatus.REJECTED
        ? {
            category: SupportTicketCategory.BOOKINGS_AND_RIDES,
            subcategory:
              claim.kind === NoShowClaimKind.DRIVER_NO_SHOW
                ? SupportBookingsSubcategory.DRIVER_BEHAVIOUR
                : SupportBookingsSubcategory.OTHER,
            message:
              'This claim was rejected. Open Help & Support to continue. No No-Show penalties, refunds, or cancellation were applied.',
            ticketId: claim.supportTicketId,
          }
        : null;

    return {
      id: claim.id,
      rideId: claim.rideId,
      bookingId: claim.bookingId,
      rideType: claim.rideType,
      kind: claim.kind,
      claimantUserId: claim.claimantUserId,
      respondentUserId: claim.respondentUserId,
      status: claim.status,
      respondBy: claim.respondBy.toISOString(),
      respondedAt: claim.respondedAt ? claim.respondedAt.toISOString() : null,
      respondedByUserId: claim.respondedByUserId,
      decisionSource: claim.decisionSource,
      settledAt: claim.settledAt ? claim.settledAt.toISOString() : null,
      settlementIdempotencyKey: claim.settlementIdempotencyKey,
      supportTicketId: claim.supportTicketId,
      createdAt: claim.createdAt.toISOString(),
      updatedAt: claim.updatedAt.toISOString(),
      alreadyOpen,
      support,
      effects: effects.map(
        (row): NoShowClaimEffectDto => ({
          kind: row.kind,
          status: row.status,
          attemptCount: row.attemptCount,
          nextAttemptAt: row.nextAttemptAt
            ? row.nextAttemptAt.toISOString()
            : null,
          lastError: row.lastError,
          completedAt: row.completedAt ? row.completedAt.toISOString() : null,
        }),
      ),
    };
  }
}
