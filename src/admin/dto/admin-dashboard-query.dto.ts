import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export enum AdminLiveMapFilter {
  ACTIVE = 'ACTIVE',
  OFFICE_COMMUTE = 'OFFICE_COMMUTE',
  OUTSTATION = 'OUTSTATION',
  SOS = 'SOS',
}

export class AdminLiveMapQueryDto {
  @ApiPropertyOptional({
    enum: AdminLiveMapFilter,
    enumName: 'AdminLiveMapFilter',
    default: AdminLiveMapFilter.ACTIVE,
    description:
      'ACTIVE = all IN_PROGRESS. OFFICE_COMMUTE = COMMUTE. OUTSTATION = REGULAR+ASSURED (no OUTSTATION ride type exists). SOS = empty until SOS is implemented.',
  })
  @IsOptional()
  @IsEnum(AdminLiveMapFilter)
  filter?: AdminLiveMapFilter = AdminLiveMapFilter.ACTIVE;
}

export class AdminRecentActivityQueryDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'ISO timestamp cursor (createdAt of last item)',
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
