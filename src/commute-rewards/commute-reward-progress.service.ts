import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingMode,
  BookingPickupStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import {
  addCalendarMonthsInTimeZone,
  isWithinWindow,
} from './commute-reward-time';
import {
  countDistinctQualifyingPassengers,
  MIN_QUALIFYING_PASSENGERS,
} from './commute-reward-qualification';
import { CommuteRewardCampaign } from './entities/commute-reward-campaign.entity';
import { CommuteRewardClaim } from './entities/commute-reward-claim.entity';
import { CommuteRewardMilestone } from './entities/commute-reward-milestone.entity';
import { CommuteRewardQualifyingTrip } from './entities/commute-reward-qualifying-trip.entity';
import {
  COMMUTE_REWARD_CONSUMING_CLAIM_STATUSES,
  COMMUTE_REWARD_SUCCESS_CLAIM_STATUSES,
  CommuteRewardCampaignStatus,
  CommuteRewardClaimStatus,
} from './enums/commute-reward.enums';

@Injectable()
export class CommuteRewardProgressService {
  constructor(
    @InjectRepository(CommuteRewardCampaign)
    private readonly campaignRepository: Repository<CommuteRewardCampaign>,
    @InjectRepository(CommuteRewardMilestone)
    private readonly milestoneRepository: Repository<CommuteRewardMilestone>,
    @InjectRepository(CommuteRewardQualifyingTrip)
    private readonly tripRepository: Repository<CommuteRewardQualifyingTrip>,
    @InjectRepository(CommuteRewardClaim)
    private readonly claimRepository: Repository<CommuteRewardClaim>,
  ) {}

  /**
   * Idempotent: record a qualifying Office Commute completion for all ACTIVE
   * campaigns whose date window includes ride.completedAt.
   * Safe under complete() retries (unique campaign_id + ride_id).
   */
  async recordQualifyingRideInTransaction(
    manager: EntityManager,
    ride: Ride,
  ): Promise<{ recorded: number; skippedReason?: string }> {
    if (ride.rideType !== RideType.COMMUTE) {
      return { recorded: 0, skippedReason: 'not_commute' };
    }
    if (ride.status !== RideStatus.COMPLETED || !ride.completedAt) {
      return { recorded: 0, skippedReason: 'ride_not_completed' };
    }

    const bookings = await manager.getRepository(Booking).find({
      where: {
        rideId: ride.id,
        bookingMode: BookingMode.COMMUTE,
      },
      select: {
        id: true,
        passengerId: true,
        status: true,
        bookingMode: true,
        pickupStatus: true,
      },
    });

    const passengerCount = countDistinctQualifyingPassengers(bookings);
    if (passengerCount < MIN_QUALIFYING_PASSENGERS) {
      return { recorded: 0, skippedReason: 'insufficient_passengers' };
    }

    const completedAt = ride.completedAt;
    const campaigns = await manager.getRepository(CommuteRewardCampaign).find({
      where: { status: CommuteRewardCampaignStatus.ACTIVE },
    });

    let recorded = 0;
    for (const campaign of campaigns) {
      if (
        completedAt.getTime() < campaign.startsAt.getTime() ||
        completedAt.getTime() > campaign.endsAt.getTime()
      ) {
        continue;
      }

      const existing = await manager
        .getRepository(CommuteRewardQualifyingTrip)
        .findOne({
          where: { campaignId: campaign.id, rideId: ride.id },
        });
      if (existing) {
        continue;
      }

      try {
        await manager.getRepository(CommuteRewardQualifyingTrip).save(
          manager.getRepository(CommuteRewardQualifyingTrip).create({
            campaignId: campaign.id,
            driverId: ride.driverId,
            rideId: ride.id,
            completedPassengerCount: passengerCount,
            completedAt,
            campaignConfigVersion: campaign.configVersion,
          }),
        );
        recorded += 1;
      } catch (error) {
        // Unique violation on retry — treat as idempotent success.
        if (this.isUniqueViolation(error)) {
          continue;
        }
        throw error;
      }
    }

    return { recorded };
  }

  async countTripsInWindow(
    campaignId: string,
    driverId: string,
    windowStart: Date,
    windowEndExclusive: Date,
    manager?: EntityManager,
  ): Promise<number> {
    const repo =
      manager?.getRepository(CommuteRewardQualifyingTrip) ?? this.tripRepository;
    return repo
      .createQueryBuilder('t')
      .where('t.campaign_id = :campaignId', { campaignId })
      .andWhere('t.driver_id = :driverId', { driverId })
      .andWhere('t.completed_at >= :start', { start: windowStart })
      .andWhere('t.completed_at < :end', { end: windowEndExclusive })
      .getCount();
  }

  async totalQualifyingTrips(
    campaignId: string,
    driverId: string,
    manager?: EntityManager,
  ): Promise<number> {
    const repo =
      manager?.getRepository(CommuteRewardQualifyingTrip) ?? this.tripRepository;
    return repo.count({ where: { campaignId, driverId } });
  }

  milestoneWindowEnd(
    campaign: CommuteRewardCampaign,
    milestone: CommuteRewardMilestone,
  ): Date {
    return addCalendarMonthsInTimeZone(
      campaign.startsAt,
      milestone.windowMonths,
      campaign.timezone,
    );
  }

  async evaluateMilestoneEligibility(
    campaign: CommuteRewardCampaign,
    milestone: CommuteRewardMilestone,
    driverId: string,
    now = new Date(),
    manager?: EntityManager,
  ): Promise<{
    tripCountInWindow: number;
    requiredTrips: number;
    windowEndAt: Date;
    windowOpen: boolean;
    thresholdMet: boolean;
    precedingClaimed: boolean;
    alreadyClaimed: boolean;
    canClaim: boolean;
    claimStatus: CommuteRewardClaimStatus | null;
  }> {
    const windowEnd = this.milestoneWindowEnd(campaign, milestone);
    const windowOpen =
      now.getTime() >= campaign.startsAt.getTime() &&
      now.getTime() <= campaign.endsAt.getTime() &&
      now.getTime() < windowEnd.getTime() &&
      (campaign.status === CommuteRewardCampaignStatus.ACTIVE ||
        campaign.status === CommuteRewardCampaignStatus.PAUSED);

    const tripCountInWindow = await this.countTripsInWindow(
      campaign.id,
      driverId,
      campaign.startsAt,
      windowEnd,
      manager,
    );

    const claimRepo =
      manager?.getRepository(CommuteRewardClaim) ?? this.claimRepository;
    const existingClaim = await claimRepo.findOne({
      where: {
        campaignId: campaign.id,
        driverId,
        milestoneId: milestone.id,
      },
    });

    const alreadyClaimed =
      existingClaim != null &&
      COMMUTE_REWARD_CONSUMING_CLAIM_STATUSES.includes(existingClaim.status);

    const precedingClaimed = await this.arePrecedingMilestonesSuccessfullyClaimed(
      campaign.id,
      driverId,
      milestone.sortOrder,
      manager,
    );

    const thresholdMet = tripCountInWindow >= milestone.requiredTrips;
    const canClaim =
      campaign.status === CommuteRewardCampaignStatus.ACTIVE &&
      now.getTime() >= campaign.startsAt.getTime() &&
      now.getTime() <= campaign.endsAt.getTime() &&
      now.getTime() < windowEnd.getTime() &&
      thresholdMet &&
      precedingClaimed &&
      !alreadyClaimed;

    return {
      tripCountInWindow,
      requiredTrips: milestone.requiredTrips,
      windowEndAt: windowEnd,
      windowOpen,
      thresholdMet,
      precedingClaimed,
      alreadyClaimed,
      canClaim,
      claimStatus: existingClaim?.status ?? null,
    };
  }

  private async arePrecedingMilestonesSuccessfullyClaimed(
    campaignId: string,
    driverId: string,
    sortOrder: number,
    manager?: EntityManager,
  ): Promise<boolean> {
    if (sortOrder <= 1) {
      return true;
    }
    const milestoneRepo =
      manager?.getRepository(CommuteRewardMilestone) ?? this.milestoneRepository;
    const claimRepo =
      manager?.getRepository(CommuteRewardClaim) ?? this.claimRepository;

    const preceding = await milestoneRepo.find({
      where: { campaignId },
      order: { sortOrder: 'ASC' },
    });
    const needed = preceding.filter((m) => m.sortOrder < sortOrder);
    if (needed.length === 0) {
      return true;
    }

    const claims = await claimRepo.find({
      where: {
        campaignId,
        driverId,
        milestoneId: In(needed.map((m) => m.id)),
        status: In([...COMMUTE_REWARD_SUCCESS_CLAIM_STATUSES]),
      },
    });
    const claimedIds = new Set(claims.map((c) => c.milestoneId));
    return needed.every((m) => claimedIds.has(m.id));
  }

  /** Exported for unit tests without DB. */
  static isTripStillInWindow(
    completedAt: Date,
    campaignStartsAt: Date,
    windowEndExclusive: Date,
  ): boolean {
    return isWithinWindow(completedAt, campaignStartsAt, windowEndExclusive);
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    );
  }
}
