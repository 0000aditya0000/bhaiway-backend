import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  AppSetting,
  ASSURED_RIDE_DEPOSIT_PERCENTAGE_KEY,
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
}
