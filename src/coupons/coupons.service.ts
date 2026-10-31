import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { In, Repository } from 'typeorm';

import { User } from '../users/entities/user.entity';
import { validateAndParseCouponConfig } from './coupon.config';
import { CouponRedemptionService } from './coupon-redemption.service';
import {
  AssignCouponUsersDto,
  CreateCouponAdminDto,
  UpdateCouponAdminDto,
} from './dto/admin-coupon.dto';
import { PreviewCouponDto, ValidateCouponDto } from './dto/user-coupon-api.dto';
import { CouponAssignment } from './entities/coupon-assignment.entity';
import { CouponAuditLog } from './entities/coupon-audit-log.entity';
import { CouponIssuance } from './entities/coupon-issuance.entity';
import { CouponRedemption } from './entities/coupon-redemption.entity';
import { Coupon } from './entities/coupon.entity';
import {
  CouponCodeConflictError,
  CouponInvalidConfigError,
  CouponNotFoundError,
} from './errors/coupon.errors';
import {
  CouponActorContext,
  CouponAudience,
  CouponChargeScope,
  CouponRideTypeScope,
  USER_LISTING_APPLICABLE_TO,
  normalizeCouponCode,
  resolveCouponApplicableTo,
} from './enums/coupon.enums';

@Injectable()
export class CouponsService {
  constructor(
    @InjectRepository(Coupon)
    private readonly couponRepository: Repository<Coupon>,
    @InjectRepository(CouponAssignment)
    private readonly assignmentRepository: Repository<CouponAssignment>,
    @InjectRepository(CouponRedemption)
    private readonly redemptionRepository: Repository<CouponRedemption>,
    @InjectRepository(CouponAuditLog)
    private readonly auditRepository: Repository<CouponAuditLog>,
    @InjectRepository(CouponIssuance)
    private readonly issuanceRepository: Repository<CouponIssuance>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly redemptionService: CouponRedemptionService,
  ) {}

  async createAdmin(
    adminId: string,
    dto: CreateCouponAdminDto,
  ): Promise<Record<string, unknown>> {
    if (
      dto.audience === CouponAudience.USER_SPECIFIC &&
      (!dto.userIds || dto.userIds.length === 0)
    ) {
      throw new CouponInvalidConfigError(
        'USER_SPECIFIC coupons require at least one userId.',
      );
    }

    const generated =
      dto.code?.trim() ||
      `BW${randomBytes(4).toString('hex').toUpperCase()}`;

    const parsed = validateAndParseCouponConfig({
      ...dto,
      code: generated,
    });

    const existing = await this.couponRepository.findOne({
      where: { codeNormalized: parsed.codeNormalized },
    });
    if (existing) {
      throw new CouponCodeConflictError();
    }

    if (dto.userIds?.length) {
      const users = await this.userRepository.find({
        where: { id: In(dto.userIds) },
      });
      if (users.length !== new Set(dto.userIds).size) {
        throw new CouponInvalidConfigError('One or more userIds are invalid.');
      }
    }

    const coupon = this.couponRepository.create({
      code: parsed.code,
      codeNormalized: parsed.codeNormalized,
      title: parsed.title,
      description: parsed.description,
      benefitType: parsed.benefitType,
      benefitValue: parsed.benefitValue.toString(),
      maxDiscountAmount: parsed.maxDiscountAmount?.toString() ?? null,
      minEligibleAmount: parsed.minEligibleAmount?.toString() ?? null,
      rideTypeScope: parsed.rideTypeScope,
      chargeScope: parsed.chargeScope,
      audience: parsed.audience,
      applicableTo: parsed.applicableTo,
      isActive: parsed.isActive,
      startsAt: parsed.startsAt,
      expiresAt: parsed.expiresAt,
      totalRedemptionLimit: parsed.totalRedemptionLimit,
      perUserRedemptionLimit: parsed.perUserRedemptionLimit,
      redeemedCount: 0,
      reservedCount: 0,
      createdByAdminId: adminId,
    });

    const saved = await this.couponRepository.save(coupon);

    if (dto.audience === CouponAudience.USER_SPECIFIC && dto.userIds) {
      await this.assignUsers(saved.id, adminId, { userIds: dto.userIds });
    }

    await this.audit(adminId, saved.id, 'COUPON_CREATED', {
      code: saved.codeNormalized,
      audience: saved.audience,
      applicableTo: saved.applicableTo,
    });

    return this.toAdminDetail(saved.id);
  }

  async assignUsers(
    couponId: string,
    adminId: string,
    dto: AssignCouponUsersDto,
  ): Promise<{ assigned: number }> {
    const coupon = await this.couponRepository.findOne({
      where: { id: couponId },
    });
    if (!coupon) {
      throw new CouponNotFoundError();
    }
    if (coupon.audience !== CouponAudience.USER_SPECIFIC) {
      throw new CouponInvalidConfigError(
        'Only USER_SPECIFIC coupons accept assignments.',
      );
    }

    const uniqueIds = [...new Set(dto.userIds)];
    const users = await this.userRepository.find({
      where: { id: In(uniqueIds) },
    });
    if (users.length !== uniqueIds.length) {
      throw new CouponInvalidConfigError('One or more userIds are invalid.');
    }

    let assigned = 0;
    for (const userId of uniqueIds) {
      const existing = await this.assignmentRepository.findOne({
        where: { couponId, userId },
      });
      if (existing) {
        continue;
      }
      await this.assignmentRepository.save(
        this.assignmentRepository.create({
          couponId,
          userId,
          assignedByAdminId: adminId,
        }),
      );
      assigned += 1;
    }

    await this.audit(adminId, couponId, 'COUPON_ASSIGNED', {
      userIds: uniqueIds,
      newlyAssigned: assigned,
    });

    return { assigned };
  }

  async updateAdmin(
    couponId: string,
    adminId: string,
    dto: UpdateCouponAdminDto,
  ): Promise<Record<string, unknown>> {
    const coupon = await this.couponRepository.findOne({
      where: { id: couponId },
    });
    if (!coupon) {
      throw new CouponNotFoundError();
    }

    const previousApplicableTo = resolveCouponApplicableTo(coupon.applicableTo);
    if (dto.applicableTo != null) {
      coupon.applicableTo = dto.applicableTo;
      await this.couponRepository.save(coupon);
      await this.audit(adminId, couponId, 'COUPON_UPDATED', {
        applicableTo: {
          from: previousApplicableTo,
          to: dto.applicableTo,
        },
      });
    }

    return this.toAdminDetail(couponId);
  }

  async setActive(
    couponId: string,
    adminId: string,
    isActive: boolean,
  ): Promise<Record<string, unknown>> {
    const coupon = await this.couponRepository.findOne({
      where: { id: couponId },
    });
    if (!coupon) {
      throw new CouponNotFoundError();
    }
    coupon.isActive = isActive;
    await this.couponRepository.save(coupon);
    await this.audit(adminId, couponId, isActive ? 'COUPON_ACTIVATED' : 'COUPON_DEACTIVATED', {});
    return this.toAdminDetail(couponId);
  }

  async listAdmin(page = 1, limit = 20) {
    const [items, total] = await this.couponRepository.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items: items.map((c) => this.toPublicCoupon(c, true)),
      page,
      limit,
      total,
    };
  }

  async toAdminDetail(couponId: string): Promise<Record<string, unknown>> {
    const coupon = await this.couponRepository.findOne({
      where: { id: couponId },
    });
    if (!coupon) {
      throw new CouponNotFoundError();
    }

    const assignments = await this.assignmentRepository.find({
      where: { couponId },
      order: { createdAt: 'DESC' },
      take: 200,
    });

    const redemptions = await this.redemptionRepository.find({
      where: { couponId },
      order: { createdAt: 'DESC' },
      take: 100,
    });

    const issuances = await this.issuanceRepository.find({
      where: { couponId },
      order: { createdAt: 'DESC' },
      take: 50,
    });

    const audit = await this.auditRepository.find({
      where: { couponId },
      order: { createdAt: 'DESC' },
      take: 50,
    });

    return {
      ...this.toPublicCoupon(coupon, true),
      assignments: assignments.map((a) => ({
        id: a.id,
        userId: a.userId,
        assignedByAdminId: a.assignedByAdminId,
        createdAt: a.createdAt.toISOString(),
      })),
      redemptions: redemptions.map((r) => this.toRedemptionDto(r)),
      issuances: issuances.map((i) => ({
        id: i.id,
        userId: i.userId,
        source: i.source,
        status: i.status,
        ruleIdentifier: i.ruleIdentifier,
        ruleVersion: i.ruleVersion,
        tripId: i.tripId,
        createdAt: i.createdAt.toISOString(),
      })),
      audit: audit.map((a) => ({
        id: a.id,
        action: a.action,
        adminId: a.adminId,
        metadata: a.metadata,
        createdAt: a.createdAt.toISOString(),
      })),
      usage: {
        redeemedCount: coupon.redeemedCount,
        reservedCount: coupon.reservedCount,
        totalRedemptionLimit: coupon.totalRedemptionLimit,
        perUserRedemptionLimit: coupon.perUserRedemptionLimit,
      },
    };
  }

  async listPublicForUser(userId: string, page = 1, limit = 20) {
    const now = new Date();
    const qb = this.couponRepository
      .createQueryBuilder('c')
      .where('c.audience = :audience', { audience: CouponAudience.PUBLIC })
      .andWhere('c.is_active = true')
      .andWhere('c.starts_at <= :now', { now })
      .andWhere('c.expires_at >= :now', { now })
      // Hide globally exhausted coupons from discovery.
      .andWhere(
        '(c.total_redemption_limit IS NULL OR (c.redeemed_count + c.reserved_count) < c.total_redemption_limit)',
      )
      .andWhere(
        '(c.applicable_to IS NULL OR c.applicable_to IN (:...userApplicableTo))',
        { userApplicableTo: USER_LISTING_APPLICABLE_TO },
      )
      .orderBy('c.expires_at', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    void userId;
    return {
      items: items.map((c) => this.toPublicCoupon(c, false)),
      page,
      limit,
      total,
    };
  }

  async listAssignedForUser(userId: string, page = 1, limit = 20) {
    const now = new Date();
    const qb = this.couponRepository
      .createQueryBuilder('c')
      .innerJoin(
        CouponAssignment,
        'a',
        'a.coupon_id = c.id AND a.user_id = :userId',
        { userId },
      )
      .where('c.audience = :audience', {
        audience: CouponAudience.USER_SPECIFIC,
      })
      .andWhere('c.is_active = true')
      .andWhere('c.starts_at <= :now', { now })
      .andWhere('c.expires_at >= :now', { now })
      .andWhere(
        '(c.total_redemption_limit IS NULL OR (c.redeemed_count + c.reserved_count) < c.total_redemption_limit)',
      )
      .andWhere(
        '(c.applicable_to IS NULL OR c.applicable_to IN (:...userApplicableTo))',
        { userApplicableTo: USER_LISTING_APPLICABLE_TO },
      )
      .orderBy('c.expires_at', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    return {
      items: items.map((c) => this.toPublicCoupon(c, false)),
      page,
      limit,
      total,
    };
  }

  async getForUser(userId: string, couponId: string) {
    const coupon = await this.couponRepository.findOne({
      where: { id: couponId },
    });
    if (!coupon) {
      throw new CouponNotFoundError();
    }
    if (coupon.audience === CouponAudience.USER_SPECIFIC) {
      const assignment = await this.assignmentRepository.findOne({
        where: { couponId, userId },
      });
      if (!assignment) {
        throw new CouponNotFoundError();
      }
    } else if (coupon.audience !== CouponAudience.PUBLIC) {
      throw new CouponNotFoundError();
    }
    return this.toPublicCoupon(coupon, false);
  }

  async validateForUser(userId: string, dto: ValidateCouponDto) {
    const amount = dto.amount != null ? BigInt(dto.amount) : 0n;
    const preview = await this.redemptionService.preview(dto.code, {
      userId,
      rideType: dto.rideType,
      chargeScope: dto.chargeScope,
      amount,
      actorContext: CouponActorContext.RIDER,
    });
    return {
      valid: true,
      code: preview.coupon.codeNormalized,
      benefitType: preview.coupon.benefitType,
      rideTypeScope: preview.coupon.rideTypeScope,
      chargeScope: preview.coupon.chargeScope,
      applicableTo: resolveCouponApplicableTo(preview.coupon.applicableTo),
      originalAmount: preview.originalAmount.toString(),
      discountAmount: preview.discountAmount.toString(),
      finalAmount: preview.finalAmount.toString(),
      pointsCredit: preview.pointsCredit,
    };
  }

  async previewForUser(userId: string, dto: PreviewCouponDto) {
    if (!/^\d+$/.test(dto.amount.trim())) {
      throw new CouponInvalidConfigError('amount must be a non-negative integer.');
    }
    return this.validateForUser(userId, dto);
  }

  async listRedemptionsForUser(userId: string, page = 1, limit = 20) {
    const [items, total] = await this.redemptionRepository.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items: items.map((r) => this.toRedemptionDto(r)),
      page,
      limit,
      total,
    };
  }

  async listIssuancesForUser(userId: string, page = 1, limit = 20) {
    const [items, total] = await this.issuanceRepository.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items: items.map((i) => ({
        id: i.id,
        couponId: i.couponId,
        source: i.source,
        reason: i.reason,
        status: i.status,
        tripId: i.tripId,
        ruleIdentifier: i.ruleIdentifier,
        ruleVersion: i.ruleVersion,
        issuedAt: i.issuedAt?.toISOString() ?? null,
        createdAt: i.createdAt.toISOString(),
      })),
      page,
      limit,
      total,
    };
  }

  toPublicCoupon(coupon: Coupon, includeAdmin: boolean) {
    const base: Record<string, unknown> = {
      id: coupon.id,
      code: includeAdmin ? coupon.code : coupon.codeNormalized,
      title: coupon.title,
      description: coupon.description,
      benefitType: coupon.benefitType,
      benefitValue: coupon.benefitValue,
      maxDiscountAmount: coupon.maxDiscountAmount,
      minEligibleAmount: coupon.minEligibleAmount,
      rideTypeScope: coupon.rideTypeScope,
      chargeScope: coupon.chargeScope,
      audience: coupon.audience,
      applicableTo: resolveCouponApplicableTo(coupon.applicableTo),
      isActive: coupon.isActive,
      startsAt: coupon.startsAt.toISOString(),
      expiresAt: coupon.expiresAt.toISOString(),
      totalRedemptionLimit: coupon.totalRedemptionLimit,
      perUserRedemptionLimit: coupon.perUserRedemptionLimit,
    };
    if (includeAdmin) {
      base.redeemedCount = coupon.redeemedCount;
      base.reservedCount = coupon.reservedCount;
      base.createdByAdminId = coupon.createdByAdminId;
      base.createdAt = coupon.createdAt.toISOString();
      base.updatedAt = coupon.updatedAt.toISOString();
    }
    return base;
  }

  private toRedemptionDto(r: CouponRedemption) {
    return {
      id: r.id,
      couponId: r.couponId,
      status: r.status,
      bookingId: r.bookingId,
      rideId: r.rideId,
      rideTypeScope: r.rideTypeScope,
      chargeScope: r.chargeScope,
      benefitType: r.benefitTypeSnapshot,
      code: r.codeSnapshot,
      originalAmount: r.originalAmount,
      discountAmount: r.discountAmount,
      finalAmount: r.finalAmount,
      pointsCredited: r.pointsCredited,
      reservedAt: r.reservedAt?.toISOString() ?? null,
      redeemedAt: r.redeemedAt?.toISOString() ?? null,
      releasedAt: r.releasedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private async audit(
    adminId: string | null,
    couponId: string | null,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    await this.auditRepository.save(
      this.auditRepository.create({
        adminId,
        couponId,
        action,
        metadata,
      }),
    );
  }

  /** Helper for booking integration: map RideType → coupon scope. */
  static mapRideType(rideType: string): CouponRideTypeScope {
    if (rideType === 'COMMUTE') return CouponRideTypeScope.OFFICE_COMMUTE;
    if (rideType === 'ASSURED') return CouponRideTypeScope.ASSURED;
    if (rideType === 'REGULAR') return CouponRideTypeScope.REGULAR;
    return CouponRideTypeScope.ALL;
  }

  static normalizeCode(code: string): string {
    return normalizeCouponCode(code);
  }

  static chargeScopes = CouponChargeScope;
}
