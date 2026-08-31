import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';

import { SettingsService } from '../settings/settings.service';
import {
  PassengerAssuredDepositPenalty,
  PassengerAssuredDepositPenaltyReason,
} from './entities/passenger-assured-deposit-penalty.entity';
import { PASSENGER_CANCEL_ELEVATED_DEPOSIT_PERCENT } from './assured-lifecycle.math';

export const SECURITY_DEPOSIT_REASON_PREVIOUS_CANCELLATION =
  'PREVIOUS_ASSURED_CANCELLATION';

export interface PassengerAssuredDepositQuote {
  percentage: number;
  reason: string | null;
  elevated: boolean;
}

@Injectable()
export class PassengerAssuredDepositPenaltyService {
  constructor(
    @InjectRepository(PassengerAssuredDepositPenalty)
    private readonly penaltyRepository: Repository<PassengerAssuredDepositPenalty>,
    private readonly settingsService: SettingsService,
  ) {}

  async getDepositQuote(
    userId: string,
    manager?: EntityManager,
  ): Promise<PassengerAssuredDepositQuote> {
    const repo = this.repo(manager);
    const penalty = await repo.findOne({
      where: { userId, clearedAt: IsNull() },
    });

    if (penalty && penalty.consumedOnBookingId == null) {
      return {
        percentage: penalty.elevatedPercentage,
        reason: SECURITY_DEPOSIT_REASON_PREVIOUS_CANCELLATION,
        elevated: true,
      };
    }

    const percentage =
      await this.settingsService.getAssuredRideDepositPercentage();
    return {
      percentage,
      reason: null,
      elevated: false,
    };
  }

  async applyCancellationPenalty(
    manager: EntityManager,
    userId: string,
    sourceCancellationBookingId: string,
  ): Promise<number> {
    const repo = this.repo(manager);
    const existing = await repo.findOne({
      where: { userId, clearedAt: IsNull() },
    });
    if (existing) {
      return existing.elevatedPercentage;
    }

    await repo.save(
      repo.create({
        userId,
        elevatedPercentage: PASSENGER_CANCEL_ELEVATED_DEPOSIT_PERCENT,
        reason: PassengerAssuredDepositPenaltyReason.PREVIOUS_ASSURED_CANCELLATION,
        sourceCancellationBookingId,
        consumedOnBookingId: null,
        clearedAt: null,
      }),
    );
    return PASSENGER_CANCEL_ELEVATED_DEPOSIT_PERCENT;
  }

  async markConsumedOnBooking(
    manager: EntityManager,
    userId: string,
    bookingId: string,
  ): Promise<void> {
    const repo = this.repo(manager);
    const penalty = await repo.findOne({
      where: { userId, clearedAt: IsNull() },
    });
    if (!penalty || penalty.consumedOnBookingId != null) {
      return;
    }
    penalty.consumedOnBookingId = bookingId;
    await repo.save(penalty);
  }

  async reopenIfConsumedBookingCancelled(
    manager: EntityManager,
    userId: string,
    bookingId: string,
  ): Promise<void> {
    const repo = this.repo(manager);
    const penalty = await repo.findOne({
      where: { userId, clearedAt: IsNull() },
    });
    if (!penalty || penalty.consumedOnBookingId !== bookingId) {
      return;
    }
    penalty.consumedOnBookingId = null;
    await repo.save(penalty);
  }

  async clearOnCompletedAssuredBooking(
    manager: EntityManager,
    passengerId: string,
    bookingId: string,
  ): Promise<void> {
    const repo = this.repo(manager);
    const penalty = await repo.findOne({
      where: { userId: passengerId, clearedAt: IsNull() },
    });
    if (!penalty || penalty.consumedOnBookingId !== bookingId) {
      return;
    }
    penalty.clearedAt = new Date();
    await repo.save(penalty);
  }

  private repo(manager?: EntityManager) {
    return manager
      ? manager.getRepository(PassengerAssuredDepositPenalty)
      : this.penaltyRepository;
  }
}
