import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';

import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { calculateAssuranceWindow } from './assured-window.math';
import {
  formatGeographicQueueAuditKey,
  sortQueueIdsForLocking,
} from './assured-route-compatibility';
import {
  AssuredQueueAdvanceReason,
  AssuredQueueEventType,
} from './enums/assured-queue.enums';
import { AssuredQueueEvent } from './entities/assured-queue-event.entity';

export interface AdvanceQueueParams {
  queueId: string;
  reason: AssuredQueueAdvanceReason;
  sourceRideId?: string | null;
  idempotencyKey?: string;
}

export interface AdvanceQueueResult {
  promotedRide: Ride | null;
  alreadyApplied: boolean;
  skipped?: boolean;
}

@Injectable()
export class AssuredQueueService {
  constructor(
    @InjectRepository(AssuredQueueEvent)
    private readonly queueEventRepository: Repository<AssuredQueueEvent>,
  ) {}

  applyAssuranceWindowFields(ride: Ride): void {
    const window = calculateAssuranceWindow(
      ride.departureDate,
      ride.departureTime,
    );
    ride.assuranceWindowStart = window.windowStartTime;
    ride.assuranceWindowEnd = window.windowEndTime;
  }

  async saveNewAssuredRideInTransaction(
    manager: EntityManager,
    ride: Ride,
  ): Promise<Ride> {
    return manager.getRepository(Ride).save(ride);
  }

  /**
   * Assign visibility status for a newly created Assured ride.
   * Geographic queue membership must already be set on the ride.
   */
  async enqueueAssuredRideInTransaction(
    manager: EntityManager,
    ride: Ride,
  ): Promise<void> {
    if (ride.rideType !== RideType.ASSURED) {
      throw new ConflictException('Only Assured rides can be enqueued');
    }
    if (!ride.assuredQueueId) {
      throw new ConflictException(
        'Assured ride must have geographic queue membership before enqueue',
      );
    }

    const auditKey = formatGeographicQueueAuditKey(ride.assuredQueueId);
    await this.acquireQueueAdvisoryLock(manager, ride.assuredQueueId);
    await this.lockQueueRidesForUpdate(manager, ride.assuredQueueId);

    const hasBookableActive = await this.hasActiveBookableOfferInQueue(
      manager,
      ride.assuredQueueId,
    );
    ride.status = hasBookableActive
      ? RideStatus.ASSURANCE_PENDING
      : RideStatus.ASSURANCE_ACTIVE;

    await this.recordQueueEvent(manager, {
      queueKey: auditKey,
      eventType: AssuredQueueEventType.ENQUEUED,
      advanceReason: null,
      sourceRideId: ride.id,
      promotedRideId: null,
      idempotencyKey: `queue-enqueue:${ride.id}`,
      metadata: { status: ride.status, queueId: ride.assuredQueueId },
    });
  }

  /**
   * Re-evaluate queue membership after a PENDING ride's route/schedule changes.
   * Acquires queue locks in deterministic UUID order to avoid deadlocks.
   */
  async requeuePendingRideInTransaction(
    manager: EntityManager,
    ride: Ride,
    previousQueueId: string | null,
  ): Promise<void> {
    if (ride.status !== RideStatus.ASSURANCE_PENDING) {
      throw new ConflictException(
        'Only pending Assured rides can be re-queued',
      );
    }
    if (!ride.assuredQueueId) {
      throw new ConflictException(
        'Assured ride must have geographic queue membership before re-queue',
      );
    }

    const queueIds = sortQueueIdsForLocking(
      [previousQueueId, ride.assuredQueueId].filter(
        (id): id is string => id != null,
      ),
    );
    for (const queueId of queueIds) {
      await this.acquireQueueAdvisoryLock(manager, queueId);
      await this.lockQueueRidesForUpdate(manager, queueId);
    }

    const hasBookableActive = await this.hasActiveBookableOfferInQueue(
      manager,
      ride.assuredQueueId,
      ride.id,
    );
    ride.status = hasBookableActive
      ? RideStatus.ASSURANCE_PENDING
      : RideStatus.ASSURANCE_ACTIVE;
  }

  /**
   * Restore seats on an Assured ACTIVE ride without violating the one-bookable-ACTIVE
   * invariant. If another bookable ACTIVE exists, demote this ride to PENDING first.
   */
  async restoreSeatsSafelyInTransaction(
    manager: EntityManager,
    ride: Ride,
    seats: number,
  ): Promise<void> {
    if (seats <= 0) {
      return;
    }

    if (
      ride.rideType !== RideType.ASSURED ||
      ride.status !== RideStatus.ASSURANCE_ACTIVE ||
      !ride.assuredQueueId
    ) {
      ride.availableSeats = Math.min(
        ride.totalSeats,
        ride.availableSeats + seats,
      );
      return;
    }

    await this.acquireQueueAdvisoryLock(manager, ride.assuredQueueId);
    await this.lockQueueRidesForUpdate(manager, ride.assuredQueueId);

    const wouldBecomeBookable = ride.availableSeats + seats > 0;
    if (wouldBecomeBookable) {
      const hasSiblingBookable = await this.hasActiveBookableOfferInQueue(
        manager,
        ride.assuredQueueId,
        ride.id,
      );
      if (hasSiblingBookable) {
        ride.status = RideStatus.ASSURANCE_PENDING;
      }
    }

    ride.availableSeats = Math.min(
      ride.totalSeats,
      ride.availableSeats + seats,
    );
  }

  async handleRideBecameFullInTransaction(
    manager: EntityManager,
    ride: Ride,
  ): Promise<AdvanceQueueResult> {
    if (ride.rideType !== RideType.ASSURED) {
      return { promotedRide: null, alreadyApplied: false };
    }
    if (ride.status !== RideStatus.ASSURANCE_ACTIVE) {
      return { promotedRide: null, alreadyApplied: false };
    }
    if (ride.availableSeats > 0) {
      return { promotedRide: null, alreadyApplied: false };
    }
    if (!ride.assuredQueueId) {
      return { promotedRide: null, alreadyApplied: false };
    }

    return this.advanceQueueInTransaction(manager, {
      queueId: ride.assuredQueueId,
      reason: AssuredQueueAdvanceReason.FULL,
      sourceRideId: ride.id,
    });
  }

  async advanceQueueInTransaction(
    manager: EntityManager,
    params: AdvanceQueueParams,
  ): Promise<AdvanceQueueResult> {
    const isForce =
      params.reason === AssuredQueueAdvanceReason.FORCE_PUBLISH;
    if (isForce && !params.idempotencyKey?.trim()) {
      throw new BadRequestException(
        'FORCE_PUBLISH requires an explicit idempotency key',
      );
    }

    const auditKey = formatGeographicQueueAuditKey(params.queueId);
    const idempotencyKey =
      params.idempotencyKey ??
      `queue-advance:${params.queueId}:${params.reason}:${params.sourceRideId ?? 'none'}`;

    const existing = await manager.getRepository(AssuredQueueEvent).findOne({
      where: { idempotencyKey },
    });
    if (existing) {
      if (existing.promotedRideId) {
        const promoted = await manager.getRepository(Ride).findOne({
          where: { id: existing.promotedRideId },
        });
        return { promotedRide: promoted, alreadyApplied: true };
      }
      // Legacy skip events (null promoted): treat as already-applied no-op for
      // non-FORCE keys. FORCE must always supply a fresh operation key.
      return { promotedRide: null, alreadyApplied: true, skipped: true };
    }

    await this.acquireQueueAdvisoryLock(manager, params.queueId);
    await this.lockQueueRidesForUpdate(manager, params.queueId);

    const activeBookable = await this.findActiveBookableInQueue(
      manager,
      params.queueId,
    );

    // FULL may promote while the source ride is FULL (seats=0). All other reasons
    // (including DRIVER_CANCELLED / DRIVER_NO_SHOW / FORCE_PUBLISH) must not
    // promote when a bookable ACTIVE already exists.
    if (
      activeBookable &&
      params.reason !== AssuredQueueAdvanceReason.FULL
    ) {
      if (!isForce) {
        await this.recordQueueEvent(manager, {
          queueKey: auditKey,
          eventType: this.eventTypeForReason(params.reason),
          advanceReason: params.reason,
          sourceRideId: params.sourceRideId ?? null,
          promotedRideId: null,
          idempotencyKey,
          metadata: {
            skipped: 'active_bookable_exists',
            queueId: params.queueId,
          },
        });
      }
      return {
        promotedRide: null,
        alreadyApplied: false,
        skipped: true,
      };
    }

    if (
      activeBookable &&
      params.reason === AssuredQueueAdvanceReason.FULL &&
      activeBookable.availableSeats > 0 &&
      activeBookable.id !== params.sourceRideId
    ) {
      await this.recordQueueEvent(manager, {
        queueKey: auditKey,
        eventType: AssuredQueueEventType.FULL_PROMOTION,
        advanceReason: params.reason,
        sourceRideId: params.sourceRideId ?? null,
        promotedRideId: null,
        idempotencyKey,
        metadata: {
          skipped: 'another_bookable_active_exists',
          queueId: params.queueId,
        },
      });
      return {
        promotedRide: null,
        alreadyApplied: false,
        skipped: true,
      };
    }

    const candidate = await this.findNextEligiblePending(
      manager,
      params.queueId,
    );
    if (!candidate) {
      if (!isForce) {
        await this.recordQueueEvent(manager, {
          queueKey: auditKey,
          eventType: this.eventTypeForReason(params.reason),
          advanceReason: params.reason,
          sourceRideId: params.sourceRideId ?? null,
          promotedRideId: null,
          idempotencyKey,
          metadata: {
            skipped: 'no_eligible_pending',
            queueId: params.queueId,
          },
        });
      }
      return {
        promotedRide: null,
        alreadyApplied: false,
        skipped: true,
      };
    }

    candidate.status = RideStatus.ASSURANCE_ACTIVE;
    try {
      await manager.getRepository(Ride).save(candidate);
    } catch (error) {
      if (this.isActiveQueueUniqueViolation(error)) {
        const recovered = await manager
          .getRepository(AssuredQueueEvent)
          .findOne({
            where: { idempotencyKey },
          });
        if (recovered?.promotedRideId) {
          const promoted = await manager.getRepository(Ride).findOne({
            where: { id: recovered.promotedRideId },
          });
          return { promotedRide: promoted, alreadyApplied: true };
        }
        throw new ConflictException(
          'Queue promotion conflict; retry the operation',
        );
      }
      throw error;
    }

    await this.recordQueueEvent(manager, {
      queueKey: auditKey,
      eventType: this.eventTypeForReason(params.reason),
      advanceReason: params.reason,
      sourceRideId: params.sourceRideId ?? null,
      promotedRideId: candidate.id,
      idempotencyKey,
      metadata: { queueId: params.queueId },
    });

    return { promotedRide: candidate, alreadyApplied: false };
  }

  /**
   * Promote next PENDING when no bookable ACTIVE exists.
   * Requires an explicit operation idempotency key; skips do not consume the key.
   */
  async forcePublishInTransaction(
    manager: EntityManager,
    queueId: string,
    idempotencyKey: string,
  ): Promise<AdvanceQueueResult> {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException(
        'FORCE_PUBLISH requires an explicit idempotency key',
      );
    }
    return this.advanceQueueInTransaction(manager, {
      queueId,
      reason: AssuredQueueAdvanceReason.FORCE_PUBLISH,
      sourceRideId: null,
      idempotencyKey,
    });
  }

  private async hasActiveBookableOfferInQueue(
    manager: EntityManager,
    queueId: string,
    excludeRideId?: string,
  ): Promise<boolean> {
    const qb = manager
      .getRepository(Ride)
      .createQueryBuilder('ride')
      .where('ride.assured_queue_id = :queueId', { queueId })
      .andWhere('ride.ride_type = :rideType', { rideType: RideType.ASSURED })
      .andWhere('ride.status = :status', {
        status: RideStatus.ASSURANCE_ACTIVE,
      })
      .andWhere('ride.available_seats > 0');

    if (excludeRideId) {
      qb.andWhere('ride.id != :excludeRideId', { excludeRideId });
    }

    const count = await qb.getCount();
    return count > 0;
  }

  private async findActiveBookableInQueue(
    manager: EntityManager,
    queueId: string,
  ): Promise<Ride | null> {
    return manager
      .getRepository(Ride)
      .createQueryBuilder('ride')
      .where('ride.assured_queue_id = :queueId', { queueId })
      .andWhere('ride.ride_type = :rideType', { rideType: RideType.ASSURED })
      .andWhere('ride.status = :status', {
        status: RideStatus.ASSURANCE_ACTIVE,
      })
      .andWhere('ride.available_seats > 0')
      .orderBy('ride.created_at', 'ASC')
      .addOrderBy('ride.id', 'ASC')
      .getOne();
  }

  private async findNextEligiblePending(
    manager: EntityManager,
    queueId: string,
  ): Promise<Ride | null> {
    const pending = await manager
      .getRepository(Ride)
      .createQueryBuilder('ride')
      .where('ride.assured_queue_id = :queueId', { queueId })
      .andWhere('ride.ride_type = :rideType', { rideType: RideType.ASSURED })
      .andWhere('ride.status = :status', {
        status: RideStatus.ASSURANCE_PENDING,
      })
      .orderBy('ride.created_at', 'ASC')
      .addOrderBy('ride.id', 'ASC')
      .getMany();

    for (const ride of pending) {
      if (this.isEligibleForPromotion(ride)) {
        return ride;
      }
    }
    return null;
  }

  private isEligibleForPromotion(ride: Ride): boolean {
    if (ride.rideType !== RideType.ASSURED) {
      return false;
    }
    if (ride.status !== RideStatus.ASSURANCE_PENDING) {
      return false;
    }
    if (ride.availableSeats <= 0) {
      return false;
    }
    if (!ride.assuredQueueId) {
      return false;
    }
    return true;
  }

  private async acquireQueueAdvisoryLock(
    manager: EntityManager,
    queueId: string,
  ): Promise<void> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `geoqueue-lock:${queueId}`,
    ]);
  }

  private async lockQueueRidesForUpdate(
    manager: EntityManager,
    queueId: string,
  ): Promise<Ride[]> {
    return manager
      .getRepository(Ride)
      .createQueryBuilder('ride')
      .setLock('pessimistic_write')
      .where('ride.assured_queue_id = :queueId', { queueId })
      .andWhere('ride.ride_type = :rideType', { rideType: RideType.ASSURED })
      .andWhere('ride.status IN (:...statuses)', {
        statuses: [
          RideStatus.ASSURANCE_PENDING,
          RideStatus.ASSURANCE_ACTIVE,
        ],
      })
      .orderBy('ride.created_at', 'ASC')
      .addOrderBy('ride.id', 'ASC')
      .getMany();
  }

  private async recordQueueEvent(
    manager: EntityManager,
    params: {
      queueKey: string;
      eventType: AssuredQueueEventType;
      advanceReason: AssuredQueueAdvanceReason | null;
      sourceRideId: string | null;
      promotedRideId: string | null;
      idempotencyKey: string;
      metadata: Record<string, unknown> | null;
    },
  ): Promise<void> {
    try {
      const event = manager.getRepository(AssuredQueueEvent).create({
        queueKey: params.queueKey,
        eventType: params.eventType,
        advanceReason: params.advanceReason,
        sourceRideId: params.sourceRideId,
        promotedRideId: params.promotedRideId,
        idempotencyKey: params.idempotencyKey,
        metadata: params.metadata,
      });
      await manager.getRepository(AssuredQueueEvent).save(event);
    } catch (error) {
      if (this.isQueueEventUniqueViolation(error)) {
        return;
      }
      throw error;
    }
  }

  private eventTypeForReason(
    reason: AssuredQueueAdvanceReason,
  ): AssuredQueueEventType {
    switch (reason) {
      case AssuredQueueAdvanceReason.FULL:
        return AssuredQueueEventType.FULL_PROMOTION;
      case AssuredQueueAdvanceReason.FORCE_PUBLISH:
        return AssuredQueueEventType.FORCE_PUBLISHED;
      case AssuredQueueAdvanceReason.DRIVER_CANCELLED:
      case AssuredQueueAdvanceReason.DRIVER_NO_SHOW:
        return AssuredQueueEventType.CANCELLED_PROMOTION;
      default:
        return AssuredQueueEventType.PROMOTED;
    }
  }

  private isQueueEventUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const driverError = error.driverError as { code?: string };
    return driverError?.code === '23505';
  }

  private isActiveQueueUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const driverError = error.driverError as {
      code?: string;
      constraint?: string;
    };
    return (
      driverError?.code === '23505' &&
      driverError.constraint === 'UQ_rides_assured_active_bookable_queue'
    );
  }
}
