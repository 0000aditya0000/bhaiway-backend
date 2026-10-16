import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { CommuteRewardProgressService } from './commute-reward-progress.service';
import {
  CreateCommuteRewardCampaignDto,
  CreateCommuteRewardMilestoneDto,
  FulfilCommuteRewardClaimDto,
  ReviewCommuteRewardClaimDto,
  UpdateCommuteRewardCampaignDto,
  UpdateCommuteRewardMilestoneDto,
} from './dto/admin-commute-reward.dto';
import { CommuteRewardAuditLog } from './entities/commute-reward-audit-log.entity';
import { CommuteRewardCampaign } from './entities/commute-reward-campaign.entity';
import { CommuteRewardClaim } from './entities/commute-reward-claim.entity';
import { CommuteRewardMilestone } from './entities/commute-reward-milestone.entity';
import { CommuteRewardQualifyingTrip } from './entities/commute-reward-qualifying-trip.entity';
import {
  CommuteRewardCampaignStatus,
  CommuteRewardClaimStatus,
  CommuteRewardWindowType,
} from './enums/commute-reward.enums';
import {
  CommuteRewardAlreadyClaimedError,
  CommuteRewardInvalidStateError,
  CommuteRewardNotEligibleError,
  CommuteRewardNotFoundError,
} from './errors/commute-reward.errors';

@Injectable()
export class CommuteRewardsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(CommuteRewardCampaign)
    private readonly campaignRepository: Repository<CommuteRewardCampaign>,
    @InjectRepository(CommuteRewardMilestone)
    private readonly milestoneRepository: Repository<CommuteRewardMilestone>,
    @InjectRepository(CommuteRewardClaim)
    private readonly claimRepository: Repository<CommuteRewardClaim>,
    @InjectRepository(CommuteRewardQualifyingTrip)
    private readonly tripRepository: Repository<CommuteRewardQualifyingTrip>,
    @InjectRepository(CommuteRewardAuditLog)
    private readonly auditRepository: Repository<CommuteRewardAuditLog>,
    private readonly progressService: CommuteRewardProgressService,
  ) {}

  // ─── Admin campaigns ─────────────────────────────────────────────

  async createCampaign(adminId: string, dto: CreateCommuteRewardCampaignDto) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (!(endsAt > startsAt)) {
      throw new CommuteRewardInvalidStateError('endsAt must be after startsAt.');
    }

    return this.dataSource.transaction(async (manager) => {
      const campaign = await manager.getRepository(CommuteRewardCampaign).save(
        manager.getRepository(CommuteRewardCampaign).create({
          title: dto.title.trim(),
          description: dto.description?.trim() || null,
          bannerUrl: dto.bannerUrl ?? null,
          status: CommuteRewardCampaignStatus.DRAFT,
          timezone: dto.timezone?.trim() || 'Asia/Kolkata',
          startsAt,
          endsAt,
          configVersion: 1,
          createdByAdminId: adminId,
        }),
      );

      if (dto.milestones?.length) {
        this.assertMilestoneOrders(dto.milestones);
        for (const m of dto.milestones) {
          await manager.getRepository(CommuteRewardMilestone).save(
            manager.getRepository(CommuteRewardMilestone).create({
              campaignId: campaign.id,
              sortOrder: m.sortOrder,
              title: m.title.trim(),
              requiredTrips: m.requiredTrips,
              windowType: CommuteRewardWindowType.CALENDAR_MONTHS_FROM_START,
              windowMonths: m.windowMonths,
              prizeValueCapInr: m.prizeValueCapInr,
              prizeDescription: m.prizeDescription?.trim() || null,
              prizeImageUrl: m.prizeImageUrl ?? null,
            }),
          );
        }
      }

      await this.audit(manager, {
        campaignId: campaign.id,
        adminId,
        action: 'CAMPAIGN_CREATED',
        metadata: { title: campaign.title },
      });

      return this.getCampaignDetailWithManager(manager, campaign.id);
    });
  }

  async listCampaigns(page = 1, limit = 20, status?: CommuteRewardCampaignStatus) {
    const where = status ? { status } : {};
    const [items, total] = await this.campaignRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items: items.map((c) => this.toCampaignSummary(c)),
      page,
      limit,
      total,
    };
  }

  async getCampaignDetail(campaignId: string) {
    return this.getCampaignDetailWithManager(this.dataSource.manager, campaignId);
  }

  private async getCampaignDetailWithManager(
    manager: EntityManager,
    campaignId: string,
  ) {
    const campaign = await manager
      .getRepository(CommuteRewardCampaign)
      .findOne({ where: { id: campaignId } });
    if (!campaign) {
      throw new CommuteRewardNotFoundError('Campaign not found.');
    }
    const milestones = await manager.getRepository(CommuteRewardMilestone).find({
      where: { campaignId },
      order: { sortOrder: 'ASC' },
    });
    return {
      ...this.toCampaignSummary(campaign),
      milestones: milestones.map((m: CommuteRewardMilestone) =>
        this.toMilestoneDto(m),
      ),
    };
  }

  async updateCampaign(
    adminId: string,
    campaignId: string,
    dto: UpdateCommuteRewardCampaignDto,
  ) {
    const campaign = await this.requireCampaign(campaignId);
    if (campaign.status !== CommuteRewardCampaignStatus.DRAFT) {
      // Allow cosmetic fields on ACTIVE/PAUSED; block schedule/timezone edits.
      if (
        dto.startsAt != null ||
        dto.endsAt != null ||
        dto.timezone != null
      ) {
        throw new CommuteRewardInvalidStateError(
          'Schedule/timezone can only be edited while the campaign is DRAFT.',
        );
      }
    }

    if (dto.title != null) campaign.title = dto.title.trim();
    if (dto.description !== undefined) {
      campaign.description = dto.description?.trim() || null;
    }
    if (dto.bannerUrl !== undefined) campaign.bannerUrl = dto.bannerUrl;
    if (campaign.status === CommuteRewardCampaignStatus.DRAFT) {
      if (dto.timezone != null) campaign.timezone = dto.timezone.trim();
      if (dto.startsAt != null) campaign.startsAt = new Date(dto.startsAt);
      if (dto.endsAt != null) campaign.endsAt = new Date(dto.endsAt);
      if (!(campaign.endsAt > campaign.startsAt)) {
        throw new CommuteRewardInvalidStateError('endsAt must be after startsAt.');
      }
    }

    await this.campaignRepository.save(campaign);
    await this.auditStandalone({
      campaignId,
      adminId,
      action: 'CAMPAIGN_UPDATED',
      metadata: { fields: Object.keys(dto) },
    });
    return this.getCampaignDetail(campaignId);
  }

  async addMilestone(
    adminId: string,
    campaignId: string,
    dto: CreateCommuteRewardMilestoneDto,
  ) {
    const campaign = await this.requireCampaign(campaignId);
    this.assertDraftEditable(campaign);
    const existing = await this.milestoneRepository.find({
      where: { campaignId },
    });
    if (existing.some((m) => m.sortOrder === dto.sortOrder)) {
      throw new CommuteRewardInvalidStateError(
        `Milestone sortOrder ${dto.sortOrder} already exists.`,
      );
    }
    await this.milestoneRepository.save(
      this.milestoneRepository.create({
        campaignId,
        sortOrder: dto.sortOrder,
        title: dto.title.trim(),
        requiredTrips: dto.requiredTrips,
        windowType: CommuteRewardWindowType.CALENDAR_MONTHS_FROM_START,
        windowMonths: dto.windowMonths,
        prizeValueCapInr: dto.prizeValueCapInr,
        prizeDescription: dto.prizeDescription?.trim() || null,
        prizeImageUrl: dto.prizeImageUrl ?? null,
      }),
    );
    await this.auditStandalone({
      campaignId,
      adminId,
      action: 'MILESTONE_CREATED',
      metadata: { sortOrder: dto.sortOrder },
    });
    return this.getCampaignDetail(campaignId);
  }

  async updateMilestone(
    adminId: string,
    campaignId: string,
    milestoneId: string,
    dto: UpdateCommuteRewardMilestoneDto,
  ) {
    const campaign = await this.requireCampaign(campaignId);
    this.assertDraftEditable(campaign);
    const milestone = await this.milestoneRepository.findOne({
      where: { id: milestoneId, campaignId },
    });
    if (!milestone) {
      throw new CommuteRewardNotFoundError('Milestone not found.');
    }
    if (dto.title != null) milestone.title = dto.title.trim();
    if (dto.requiredTrips != null) milestone.requiredTrips = dto.requiredTrips;
    if (dto.windowMonths != null) milestone.windowMonths = dto.windowMonths;
    if (dto.prizeValueCapInr != null) {
      milestone.prizeValueCapInr = dto.prizeValueCapInr;
    }
    if (dto.prizeDescription !== undefined) {
      milestone.prizeDescription = dto.prizeDescription?.trim() || null;
    }
    if (dto.prizeImageUrl !== undefined) {
      milestone.prizeImageUrl = dto.prizeImageUrl;
    }
    await this.milestoneRepository.save(milestone);
    await this.auditStandalone({
      campaignId,
      adminId,
      action: 'MILESTONE_UPDATED',
      metadata: { milestoneId },
    });
    return this.getCampaignDetail(campaignId);
  }

  async setCampaignStatus(
    adminId: string,
    campaignId: string,
    next: CommuteRewardCampaignStatus,
  ) {
    const campaign = await this.requireCampaign(campaignId);
    const allowed = this.allowedTransitions(campaign.status);
    if (!allowed.includes(next)) {
      throw new CommuteRewardInvalidStateError(
        `Cannot transition from ${campaign.status} to ${next}.`,
      );
    }

    if (next === CommuteRewardCampaignStatus.ACTIVE) {
      const milestones = await this.milestoneRepository.count({
        where: { campaignId },
      });
      if (milestones < 1) {
        throw new CommuteRewardInvalidStateError(
          'Activate requires at least one milestone.',
        );
      }
      if (!(campaign.endsAt > new Date())) {
        throw new CommuteRewardInvalidStateError(
          'Cannot activate a campaign whose endsAt is in the past.',
        );
      }
    }

    campaign.status = next;
    await this.campaignRepository.save(campaign);
    await this.auditStandalone({
      campaignId,
      adminId,
      action: `CAMPAIGN_${next}`,
      metadata: {},
    });
    return this.getCampaignDetail(campaignId);
  }

  async listDriverProgressAdmin(
    campaignId: string,
    page = 1,
    limit = 20,
  ) {
    await this.requireCampaign(campaignId);
    const rows = await this.tripRepository
      .createQueryBuilder('t')
      .select('t.driver_id', 'driverId')
      .addSelect('COUNT(*)::int', 'qualifyingTrips')
      .where('t.campaign_id = :campaignId', { campaignId })
      .groupBy('t.driver_id')
      .orderBy('"qualifyingTrips"', 'DESC')
      .offset((page - 1) * limit)
      .limit(limit)
      .getRawMany<{ driverId: string; qualifyingTrips: string }>();

    const items = [];
    for (const row of rows) {
      items.push({
        driverId: row.driverId,
        qualifyingTrips: Number(row.qualifyingTrips),
        progress: await this.buildDriverProgress(campaignId, row.driverId),
      });
    }
    return { items, page, limit };
  }

  async listClaimsAdmin(
    page = 1,
    limit = 20,
    status?: CommuteRewardClaimStatus,
    campaignId?: string,
  ) {
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (campaignId) where.campaignId = campaignId;
    const [items, total] = await this.claimRepository.findAndCount({
      where,
      order: { claimedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items: items.map((c) => this.toClaimDto(c)),
      page,
      limit,
      total,
    };
  }

  async reviewClaim(
    adminId: string,
    claimId: string,
    dto: ReviewCommuteRewardClaimDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const claim = await manager
        .getRepository(CommuteRewardClaim)
        .createQueryBuilder('c')
        .setLock('pessimistic_write')
        .where('c.id = :id', { id: claimId })
        .getOne();
      if (!claim) {
        throw new CommuteRewardNotFoundError('Claim not found.');
      }
      if (claim.status !== CommuteRewardClaimStatus.UNDER_REVIEW) {
        throw new CommuteRewardInvalidStateError(
          `Claim is ${claim.status}; only UNDER_REVIEW can be reviewed.`,
        );
      }
      if (dto.decision === 'REJECT' && !dto.reason?.trim()) {
        throw new CommuteRewardInvalidStateError(
          'Rejection requires a reason.',
        );
      }

      claim.status =
        dto.decision === 'APPROVE'
          ? CommuteRewardClaimStatus.APPROVED
          : CommuteRewardClaimStatus.REJECTED;
      claim.reviewedAt = new Date();
      claim.reviewedByAdminId = adminId;
      claim.rejectionReason =
        dto.decision === 'REJECT' ? dto.reason!.trim() : null;
      await manager.getRepository(CommuteRewardClaim).save(claim);

      await this.audit(manager, {
        campaignId: claim.campaignId,
        claimId: claim.id,
        adminId,
        driverId: claim.driverId,
        action: `CLAIM_${claim.status}`,
        metadata: { reason: claim.rejectionReason },
      });

      return this.toClaimDto(claim);
    });
  }

  async fulfilClaim(
    adminId: string,
    claimId: string,
    dto: FulfilCommuteRewardClaimDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const claim = await manager
        .getRepository(CommuteRewardClaim)
        .createQueryBuilder('c')
        .setLock('pessimistic_write')
        .where('c.id = :id', { id: claimId })
        .getOne();
      if (!claim) {
        throw new CommuteRewardNotFoundError('Claim not found.');
      }
      if (claim.status !== CommuteRewardClaimStatus.APPROVED) {
        throw new CommuteRewardInvalidStateError(
          'Only APPROVED claims can be marked FULFILLED.',
        );
      }
      claim.status = CommuteRewardClaimStatus.FULFILLED;
      claim.fulfilledAt = new Date();
      claim.fulfilmentNotes = dto.notes?.trim() || null;
      claim.reviewedByAdminId = adminId;
      await manager.getRepository(CommuteRewardClaim).save(claim);
      await this.audit(manager, {
        campaignId: claim.campaignId,
        claimId: claim.id,
        adminId,
        driverId: claim.driverId,
        action: 'CLAIM_FULFILLED',
        metadata: {},
      });
      return this.toClaimDto(claim);
    });
  }

  async listAudit(campaignId: string, page = 1, limit = 50) {
    await this.requireCampaign(campaignId);
    const [items, total] = await this.auditRepository.findAndCount({
      where: { campaignId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items: items.map((a) => ({
        id: a.id,
        action: a.action,
        adminId: a.adminId,
        driverId: a.driverId,
        claimId: a.claimId,
        metadata: a.metadata,
        createdAt: a.createdAt.toISOString(),
      })),
      page,
      limit,
      total,
    };
  }

  // ─── Driver APIs ─────────────────────────────────────────────────

  async listActiveForDriver(driverId: string) {
    const now = new Date();
    const campaigns = await this.campaignRepository
      .createQueryBuilder('c')
      .where('c.status = :status', { status: CommuteRewardCampaignStatus.ACTIVE })
      .andWhere('c.starts_at <= :now', { now })
      .andWhere('c.ends_at >= :now', { now })
      .orderBy('c.ends_at', 'ASC')
      .getMany();

    return {
      items: await Promise.all(
        campaigns.map(async (c) => ({
          ...this.toCampaignSummary(c),
          progress: await this.buildDriverProgress(c.id, driverId),
        })),
      ),
    };
  }

  async getDriverCampaign(driverId: string, campaignId: string) {
    const campaign = await this.requireCampaign(campaignId);
    if (
      campaign.status === CommuteRewardCampaignStatus.DRAFT ||
      campaign.status === CommuteRewardCampaignStatus.ARCHIVED
    ) {
      throw new CommuteRewardNotFoundError('Campaign not available.');
    }
    return {
      ...this.toCampaignSummary(campaign),
      milestones: (
        await this.milestoneRepository.find({
          where: { campaignId },
          order: { sortOrder: 'ASC' },
        })
      ).map((m) => this.toMilestoneDto(m)),
      progress: await this.buildDriverProgress(campaignId, driverId),
    };
  }

  async claimMilestone(
    driverId: string,
    campaignId: string,
    milestoneId: string,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const campaign = await manager
        .getRepository(CommuteRewardCampaign)
        .createQueryBuilder('c')
        .setLock('pessimistic_write')
        .where('c.id = :id', { id: campaignId })
        .getOne();
      if (!campaign) {
        throw new CommuteRewardNotFoundError('Campaign not found.');
      }
      if (campaign.status !== CommuteRewardCampaignStatus.ACTIVE) {
        throw new CommuteRewardNotEligibleError(
          'Campaign is not active for new claims.',
        );
      }
      const now = new Date();
      if (now < campaign.startsAt || now > campaign.endsAt) {
        throw new CommuteRewardNotEligibleError(
          'Campaign is outside its eligible date range.',
        );
      }

      const milestone = await manager.getRepository(CommuteRewardMilestone).findOne({
        where: { id: milestoneId, campaignId },
      });
      if (!milestone) {
        throw new CommuteRewardNotFoundError('Milestone not found.');
      }

      const eligibility = await this.progressService.evaluateMilestoneEligibility(
        campaign,
        milestone,
        driverId,
        now,
        manager,
      );

      if (eligibility.alreadyClaimed) {
        throw new CommuteRewardAlreadyClaimedError();
      }
      if (!eligibility.precedingClaimed) {
        throw new CommuteRewardNotEligibleError(
          'Claim preceding milestones first.',
        );
      }
      if (!eligibility.thresholdMet) {
        throw new CommuteRewardNotEligibleError(
          `Need ${milestone.requiredTrips} qualifying trips in window; have ${eligibility.tripCountInWindow}.`,
        );
      }
      if (now.getTime() >= eligibility.windowEndAt.getTime()) {
        throw new CommuteRewardNotEligibleError(
          'Milestone claim window has ended.',
        );
      }

      const prizeSnapshot = {
        title: milestone.title,
        sortOrder: milestone.sortOrder,
        requiredTrips: milestone.requiredTrips,
        windowMonths: milestone.windowMonths,
        prizeValueCapInr: milestone.prizeValueCapInr,
        prizeDescription: milestone.prizeDescription,
        prizeImageUrl: milestone.prizeImageUrl,
      };

      try {
        const claimRepo = manager.getRepository(CommuteRewardClaim);
        const existing = await claimRepo
          .createQueryBuilder('c')
          .setLock('pessimistic_write')
          .where('c.campaign_id = :campaignId', { campaignId })
          .andWhere('c.driver_id = :driverId', { driverId })
          .andWhere('c.milestone_id = :milestoneId', { milestoneId })
          .getOne();

        let claim: CommuteRewardClaim;
        if (existing) {
          // UNIQUE(campaign,driver,milestone) retained: only REJECTED may re-submit.
          if (existing.status !== CommuteRewardClaimStatus.REJECTED) {
            throw new CommuteRewardAlreadyClaimedError();
          }
          existing.status = CommuteRewardClaimStatus.UNDER_REVIEW;
          existing.campaignConfigVersion = campaign.configVersion;
          existing.qualifyingTripCountSnapshot = eligibility.tripCountInWindow;
          existing.prizeValueCapInrSnapshot = milestone.prizeValueCapInr;
          existing.prizeDescriptionSnapshot = milestone.prizeDescription;
          existing.prizeSnapshot = prizeSnapshot;
          existing.claimedAt = now;
          existing.rejectionReason = null;
          existing.reviewedAt = null;
          existing.reviewedByAdminId = null;
          existing.fulfilledAt = null;
          existing.fulfilmentNotes = null;
          claim = await claimRepo.save(existing);
        } else {
          claim = await claimRepo.save(
            claimRepo.create({
              campaignId,
              driverId,
              milestoneId,
              status: CommuteRewardClaimStatus.UNDER_REVIEW,
              campaignConfigVersion: campaign.configVersion,
              qualifyingTripCountSnapshot: eligibility.tripCountInWindow,
              prizeValueCapInrSnapshot: milestone.prizeValueCapInr,
              prizeDescriptionSnapshot: milestone.prizeDescription,
              prizeSnapshot,
              claimedAt: now,
            }),
          );
        }

        await this.audit(manager, {
          campaignId,
          claimId: claim.id,
          driverId,
          action: 'CLAIM_SUBMITTED',
          metadata: { milestoneId },
        });

        return this.toClaimDto(claim);
      } catch (error) {
        if (error instanceof CommuteRewardAlreadyClaimedError) {
          throw error;
        }
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: string }).code === '23505'
        ) {
          throw new CommuteRewardAlreadyClaimedError();
        }
        throw error;
      }
    });
  }

  async listDriverClaims(driverId: string, page = 1, limit = 20) {
    const [items, total] = await this.claimRepository.findAndCount({
      where: { driverId },
      order: { claimedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items: items.map((c) => this.toClaimDto(c)),
      page,
      limit,
      total,
    };
  }

  async buildDriverProgress(campaignId: string, driverId: string) {
    const campaign = await this.requireCampaign(campaignId);
    const milestones = await this.milestoneRepository.find({
      where: { campaignId },
      order: { sortOrder: 'ASC' },
    });
    const totalTrips = await this.progressService.totalQualifyingTrips(
      campaignId,
      driverId,
    );

    const milestoneProgress = [];
    for (const m of milestones) {
      const el = await this.progressService.evaluateMilestoneEligibility(
        campaign,
        m,
        driverId,
      );
      milestoneProgress.push({
        milestoneId: m.id,
        sortOrder: m.sortOrder,
        title: m.title,
        requiredTrips: m.requiredTrips,
        tripCountInWindow: el.tripCountInWindow,
        remainingTrips: Math.max(0, m.requiredTrips - el.tripCountInWindow),
        windowEndAt: el.windowEndAt.toISOString(),
        windowOpen: el.windowOpen,
        thresholdMet: el.thresholdMet,
        precedingClaimed: el.precedingClaimed,
        canClaim: el.canClaim,
        claimStatus: el.claimStatus,
        prizeValueCapInr: m.prizeValueCapInr,
        prizeDescription: m.prizeDescription,
        prizeImageUrl: m.prizeImageUrl,
      });
    }

    return {
      driverId,
      campaignId,
      totalQualifyingTrips: totalTrips,
      campaignStatus: campaign.status,
      campaignEndsAt: campaign.endsAt.toISOString(),
      milestones: milestoneProgress,
    };
  }

  // ─── helpers ─────────────────────────────────────────────────────

  private async requireCampaign(id: string): Promise<CommuteRewardCampaign> {
    const campaign = await this.campaignRepository.findOne({ where: { id } });
    if (!campaign) {
      throw new CommuteRewardNotFoundError('Campaign not found.');
    }
    return campaign;
  }

  private assertDraftEditable(campaign: CommuteRewardCampaign) {
    if (campaign.status !== CommuteRewardCampaignStatus.DRAFT) {
      throw new CommuteRewardInvalidStateError(
        'Milestones can only be created/edited while the campaign is DRAFT. Active rules are immutable; end this campaign and create a new one to change thresholds.',
      );
    }
  }

  private allowedTransitions(
    from: CommuteRewardCampaignStatus,
  ): CommuteRewardCampaignStatus[] {
    switch (from) {
      case CommuteRewardCampaignStatus.DRAFT:
        return [
          CommuteRewardCampaignStatus.ACTIVE,
          CommuteRewardCampaignStatus.ARCHIVED,
        ];
      case CommuteRewardCampaignStatus.ACTIVE:
        return [
          CommuteRewardCampaignStatus.PAUSED,
          CommuteRewardCampaignStatus.ENDED,
        ];
      case CommuteRewardCampaignStatus.PAUSED:
        return [
          CommuteRewardCampaignStatus.ACTIVE,
          CommuteRewardCampaignStatus.ENDED,
        ];
      case CommuteRewardCampaignStatus.ENDED:
        return [CommuteRewardCampaignStatus.ARCHIVED];
      default:
        return [];
    }
  }

  private assertMilestoneOrders(milestones: CreateCommuteRewardMilestoneDto[]) {
    const orders = milestones.map((m) => m.sortOrder);
    if (new Set(orders).size !== orders.length) {
      throw new CommuteRewardInvalidStateError('Duplicate milestone sortOrder.');
    }
  }

  private toCampaignSummary(c: CommuteRewardCampaign) {
    return {
      id: c.id,
      title: c.title,
      description: c.description,
      bannerUrl: c.bannerUrl,
      status: c.status,
      timezone: c.timezone,
      startsAt: c.startsAt.toISOString(),
      endsAt: c.endsAt.toISOString(),
      configVersion: c.configVersion,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  private toMilestoneDto(m: CommuteRewardMilestone) {
    return {
      id: m.id,
      sortOrder: m.sortOrder,
      title: m.title,
      requiredTrips: m.requiredTrips,
      windowType: m.windowType,
      windowMonths: m.windowMonths,
      prizeValueCapInr: m.prizeValueCapInr,
      prizeDescription: m.prizeDescription,
      prizeImageUrl: m.prizeImageUrl,
    };
  }

  private toClaimDto(c: CommuteRewardClaim) {
    return {
      id: c.id,
      campaignId: c.campaignId,
      driverId: c.driverId,
      milestoneId: c.milestoneId,
      status: c.status,
      campaignConfigVersion: c.campaignConfigVersion,
      qualifyingTripCountSnapshot: c.qualifyingTripCountSnapshot,
      prizeValueCapInrSnapshot: c.prizeValueCapInrSnapshot,
      prizeDescriptionSnapshot: c.prizeDescriptionSnapshot,
      prizeSnapshot: c.prizeSnapshot,
      rejectionReason: c.rejectionReason,
      fulfilmentNotes: c.fulfilmentNotes,
      claimedAt: c.claimedAt.toISOString(),
      reviewedAt: c.reviewedAt?.toISOString() ?? null,
      fulfilledAt: c.fulfilledAt?.toISOString() ?? null,
    };
  }

  private async audit(
    manager: { getRepository: typeof this.dataSource.manager.getRepository },
    input: {
      campaignId?: string | null;
      claimId?: string | null;
      adminId?: string | null;
      driverId?: string | null;
      action: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    await manager.getRepository(CommuteRewardAuditLog).save(
      manager.getRepository(CommuteRewardAuditLog).create({
        campaignId: input.campaignId ?? null,
        claimId: input.claimId ?? null,
        adminId: input.adminId ?? null,
        driverId: input.driverId ?? null,
        action: input.action,
        metadata: input.metadata ?? null,
      }),
    );
  }

  private async auditStandalone(input: {
    campaignId?: string | null;
    claimId?: string | null;
    adminId?: string | null;
    driverId?: string | null;
    action: string;
    metadata?: Record<string, unknown>;
  }) {
    await this.auditRepository.save(
      this.auditRepository.create({
        campaignId: input.campaignId ?? null,
        claimId: input.claimId ?? null,
        adminId: input.adminId ?? null,
        driverId: input.driverId ?? null,
        action: input.action,
        metadata: input.metadata ?? null,
      }),
    );
  }
}
