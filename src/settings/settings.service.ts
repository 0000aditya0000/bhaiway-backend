import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  AppSetting,
  ASSURED_QUEUE_CORRIDOR_RADIUS_KM_KEY,
  ASSURED_RIDE_DEPOSIT_PERCENTAGE_KEY,
  DEFAULT_ASSURED_QUEUE_CORRIDOR_RADIUS_KM,
  DEFAULT_ASSURED_RIDE_DEPOSIT_PERCENTAGE,
} from './entities/app-setting.entity';

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(AppSetting)
    private readonly settingsRepository: Repository<AppSetting>,
  ) {}

  async getAssuredRideDepositPercentage(): Promise<number> {
    const row = await this.settingsRepository.findOne({
      where: { key: ASSURED_RIDE_DEPOSIT_PERCENTAGE_KEY },
    });
    if (!row) {
      return DEFAULT_ASSURED_RIDE_DEPOSIT_PERCENTAGE;
    }
    return this.parsePercentage(row.value);
  }

  /**
   * Internal/admin foundation only — no public HTTP endpoint in this phase.
   * Changes apply to future deposits only; existing snapshots are immutable.
   */
  async getAssuredQueueCorridorRadiusKm(): Promise<number> {
    const row = await this.settingsRepository.findOne({
      where: { key: ASSURED_QUEUE_CORRIDOR_RADIUS_KM_KEY },
    });
    if (!row) {
      return DEFAULT_ASSURED_QUEUE_CORRIDOR_RADIUS_KM;
    }
    return this.parseCorridorRadiusKm(row.value);
  }

  async getAssuredQueueCorridorRadiusMeters(): Promise<number> {
    const km = await this.getAssuredQueueCorridorRadiusKm();
    return km * 1000;
  }

  /**
   * Internal/admin foundation only — no public HTTP endpoint in this phase.
   * Snapshotted on new queue creation; existing queues retain their radius.
   */
  async setAssuredQueueCorridorRadiusKm(radiusKm: number): Promise<void> {
    this.assertValidCorridorRadiusKm(radiusKm);

    let row = await this.settingsRepository.findOne({
      where: { key: ASSURED_QUEUE_CORRIDOR_RADIUS_KM_KEY },
    });
    if (!row) {
      row = this.settingsRepository.create({
        key: ASSURED_QUEUE_CORRIDOR_RADIUS_KM_KEY,
        value: String(radiusKm),
      });
    } else {
      row.value = String(radiusKm);
    }
    await this.settingsRepository.save(row);
  }

  async setAssuredRideDepositPercentage(percentage: number): Promise<void> {
    this.assertValidPercentage(percentage);

    let row = await this.settingsRepository.findOne({
      where: { key: ASSURED_RIDE_DEPOSIT_PERCENTAGE_KEY },
    });
    if (!row) {
      row = this.settingsRepository.create({
        key: ASSURED_RIDE_DEPOSIT_PERCENTAGE_KEY,
        value: String(percentage),
      });
    } else {
      row.value = String(percentage);
    }
    await this.settingsRepository.save(row);
  }

  private parsePercentage(value: string): number {
    if (!/^\d+$/.test(value)) {
      throw new NotFoundException(
        `Invalid stored deposit percentage for ${ASSURED_RIDE_DEPOSIT_PERCENTAGE_KEY}`,
      );
    }
    const parsed = Number(value);
    this.assertValidPercentage(parsed);
    return parsed;
  }

  private parseCorridorRadiusKm(value: string): number {
    if (!/^\d+$/.test(value)) {
      throw new NotFoundException(
        `Invalid stored corridor radius for ${ASSURED_QUEUE_CORRIDOR_RADIUS_KM_KEY}`,
      );
    }
    const parsed = Number(value);
    this.assertValidCorridorRadiusKm(parsed);
    return parsed;
  }

  private assertValidPercentage(percentage: number): void {
    if (
      !Number.isInteger(percentage) ||
      percentage <= 0 ||
      percentage > 100
    ) {
      throw new BadRequestException(
        'Assured deposit percentage must be an integer from 1 to 100',
      );
    }
  }

  private assertValidCorridorRadiusKm(radiusKm: number): void {
    if (
      !Number.isInteger(radiusKm) ||
      radiusKm < 5 ||
      radiusKm > 200
    ) {
      throw new BadRequestException(
        'Assured queue corridor radius must be an integer from 5 to 200 km',
      );
    }
  }
}
