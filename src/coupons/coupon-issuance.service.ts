import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { CouponIssuanceRule } from './entities/coupon-issuance-rule.entity';
import { CouponIssuance } from './entities/coupon-issuance.entity';
import { CouponIssuanceStatus } from './enums/coupon.enums';

/**
 * Automatic trip-completion coupon issuance infrastructure.
 *
 * IMPORTANT: Rules default to inactive. This delivery does not enable any
 * automatic issuance rule and does not invent qualifying conditions.
 * Calling processTripCompletion is safe and a no-op when no active rules exist.
 */
@Injectable()
export class CouponIssuanceService {
  private readonly logger = new Logger(CouponIssuanceService.name);

  constructor(
    @InjectRepository(CouponIssuanceRule)
    private readonly ruleRepository: Repository<CouponIssuanceRule>,
    @InjectRepository(CouponIssuance)
    private readonly issuanceRepository: Repository<CouponIssuance>,
  ) {}

  /**
   * Idempotent hook for ride completion. Safe under retries/duplicate events.
   * Does nothing while no active rules are configured.
   */
  async processTripCompletion(input: {
    tripId: string;
    passengerUserIds: string[];
    rideType: string;
  }): Promise<{ processed: number; issued: number }> {
    const activeRules = await this.ruleRepository.find({
      where: { isActive: true },
    });

    if (activeRules.length === 0) {
      this.logger.debug(
        `Coupon auto-issuance skipped trip=${input.tripId}: no active rules`,
      );
      return { processed: 0, issued: 0 };
    }

    // Future: evaluate rule.config against trip/user context and issue
    // USER_SPECIFIC coupons with durable CouponIssuance rows.
    // Intentionally not implemented until product defines conditions.
    this.logger.warn(
      `Active coupon issuance rules exist but evaluator is not configured; trip=${input.tripId} rules=${activeRules.length}`,
    );
    return { processed: 0, issued: 0 };
  }

  /**
   * Safe in-transaction variant used from RidesService.complete.
   * Never creates coupons while no active rules exist (default).
   * Evaluator is intentionally not activated in this delivery.
   */
  async onTripCompletedInTransaction(
    manager: EntityManager,
    input: {
      tripId: string;
      passengerUserIds: string[];
      rideType: string;
    },
  ): Promise<void> {
    const activeCount = await manager
      .getRepository(CouponIssuanceRule)
      .count({ where: { isActive: true } });

    if (activeCount === 0) {
      return;
    }

    this.logger.warn(
      `Active coupon issuance rules present but evaluator disabled; trip=${input.tripId} passengers=${input.passengerUserIds.length} rideType=${input.rideType}`,
    );
  }

  async retryFailedIssuance(issuanceId: string): Promise<CouponIssuance | null> {
    const row = await this.issuanceRepository.findOne({
      where: { id: issuanceId },
    });
    if (!row || row.status !== CouponIssuanceStatus.FAILED) {
      return row;
    }
    // Future retry path — no-op until rules/evaluator exist.
    row.attemptCount += 1;
    row.failureMessage = 'Retry skipped: automatic evaluator not activated.';
    return this.issuanceRepository.save(row);
  }
}
