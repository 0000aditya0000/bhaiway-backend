import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

import { RideStatus } from '../enums/ride.enums';

/** Past-ride status filter — only terminal lifecycle states. */
export enum RideHistoryStatusFilter {
  COMPLETED = RideStatus.COMPLETED,
  CANCELLED = RideStatus.CANCELLED,
}

export class RideHistoryQueryDto {
  @ApiPropertyOptional({
    enum: RideHistoryStatusFilter,
    enumName: 'RideHistoryStatusFilter',
    description:
      'Filter past rides. When omitted, returns both COMPLETED and CANCELLED.',
  })
  @IsOptional()
  @IsEnum(RideHistoryStatusFilter)
  status?: RideHistoryStatusFilter;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}
