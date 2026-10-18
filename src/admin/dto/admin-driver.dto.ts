import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { UserStatus } from '../../users/entities/user.entity';
import { VerificationStatus } from '../../verification/enums/verification.enums';

export enum AdminDriverStatusFilter {
  ALL = 'ALL',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  SUSPENDED = 'SUSPENDED',
}

export enum AdminDriverSortField {
  CREATED_AT = 'createdAt',
  LAST_LOGIN_AT = 'lastLoginAt',
}

export class AdminDriverListQueryDto {
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

  @ApiPropertyOptional({
    description: 'Search name, user ID, phone, or vehicle registration',
  })
  @IsOptional()
  @Transform(({ value }): string | undefined =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({
    enum: AdminDriverStatusFilter,
    default: AdminDriverStatusFilter.ALL,
    description:
      'ACTIVE = UserStatus.ACTIVE; SUSPENDED = UserStatus.SUSPENDED; INACTIVE = DEACTIVATED or no active vehicle',
  })
  @IsOptional()
  @IsEnum(AdminDriverStatusFilter)
  status?: AdminDriverStatusFilter = AdminDriverStatusFilter.ALL;

  @ApiPropertyOptional({ enum: VerificationStatus })
  @IsOptional()
  @IsEnum(VerificationStatus)
  governmentIdStatus?: VerificationStatus;

  @ApiPropertyOptional({ enum: VerificationStatus })
  @IsOptional()
  @IsEnum(VerificationStatus)
  drivingLicenceStatus?: VerificationStatus;

  @ApiPropertyOptional({ enum: VerificationStatus })
  @IsOptional()
  @IsEnum(VerificationStatus)
  vehicleRcStatus?: VerificationStatus;

  @ApiPropertyOptional({
    enum: AdminDriverSortField,
    default: AdminDriverSortField.CREATED_AT,
  })
  @IsOptional()
  @IsEnum(AdminDriverSortField)
  sortBy?: AdminDriverSortField = AdminDriverSortField.CREATED_AT;

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsEnum(['ASC', 'DESC'] as const)
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

export class AdminDriverListItemDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Same as linked user ID (no separate driver entity)',
  })
  driverId!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiPropertyOptional({ nullable: true })
  displayName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  phoneMasked!: string | null;

  @ApiPropertyOptional({ nullable: true })
  governmentIdStatus!: string | null;

  @ApiPropertyOptional({ nullable: true })
  drivingLicenceStatus!: string | null;

  @ApiPropertyOptional({ nullable: true })
  vehicleRcStatus!: string | null;

  @ApiPropertyOptional({ nullable: true })
  rating!: number | null;

  @ApiProperty({
    description:
      'Rides owned by this driver (all ride types, not double-counted)',
  })
  totalRides!: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'cancelled / (completed + cancelled) * 100. null when denominator is 0.',
  })
  cancellationRatePercent!: number | null;

  @ApiProperty({ enum: UserStatus })
  accountStatus!: UserStatus;

  @ApiProperty({
    description:
      'Operational label derived from account status + active vehicle',
  })
  operationalStatus!: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';

  @ApiPropertyOptional({ nullable: true })
  vehicleRegistrationMasked!: string | null;

  @ApiPropertyOptional({ nullable: true })
  vehicleMake!: string | null;

  @ApiPropertyOptional({ nullable: true })
  vehicleModel!: string | null;

  @ApiProperty()
  ridePublishRestricted!: boolean;

  @ApiProperty()
  createdAt!: string;
}

export class AdminDriverPageDto {
  @ApiProperty({ type: [AdminDriverListItemDto] })
  items!: AdminDriverListItemDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
