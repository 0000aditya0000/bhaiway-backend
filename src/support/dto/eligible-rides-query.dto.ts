import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

import { SupportEligibleRidePeriod } from '../enums/support.enums';

export class EligibleRidesQueryDto {
  @ApiProperty({
    enum: SupportEligibleRidePeriod,
    description: 'active = in-flight rides; past = completed/cancelled',
  })
  @IsEnum(SupportEligibleRidePeriod)
  period!: SupportEligibleRidePeriod;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
