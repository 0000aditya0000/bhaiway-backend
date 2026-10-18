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
  MinLength,
} from 'class-validator';

import { UserStatus } from '../../users/entities/user.entity';
import { VerificationStatus } from '../../verification/enums/verification.enums';

export enum AdminUserTypeFilter {
  ALL = 'ALL',
  RIDER = 'RIDER',
  DRIVER = 'DRIVER',
  BOTH = 'BOTH',
}

export enum AdminUserSortField {
  CREATED_AT = 'createdAt',
  LAST_LOGIN_AT = 'lastLoginAt',
  STATUS = 'status',
}

export class AdminUserListQueryDto {
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
    description: 'Search name, user ID, phone, or email',
  })
  @IsOptional()
  @Transform(({ value }): string | undefined =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({
    enum: AdminUserTypeFilter,
    default: AdminUserTypeFilter.ALL,
  })
  @IsOptional()
  @IsEnum(AdminUserTypeFilter)
  userType?: AdminUserTypeFilter = AdminUserTypeFilter.ALL;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({
    enum: VerificationStatus,
    description: 'Current government ID (IDENTITY) verification status',
  })
  @IsOptional()
  @IsEnum(VerificationStatus)
  governmentIdStatus?: VerificationStatus;

  @ApiPropertyOptional({
    description:
      'Corporate identity status string (e.g. VERIFIED, NOT_VERIFIED)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  corporateStatus?: string;

  @ApiPropertyOptional({
    enum: AdminUserSortField,
    default: AdminUserSortField.CREATED_AT,
  })
  @IsOptional()
  @IsEnum(AdminUserSortField)
  sortBy?: AdminUserSortField = AdminUserSortField.CREATED_AT;

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsEnum(['ASC', 'DESC'] as const)
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

export class AdminSuspendUserDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(({ value }): string =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class AdminRestrictionReasonDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(({ value }): string | undefined =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class AdminUserListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ nullable: true })
  displayName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  phoneMasked!: string | null;

  @ApiPropertyOptional({ nullable: true })
  emailMasked!: string | null;

  @ApiProperty({ enum: ['RIDER', 'DRIVER', 'BOTH'] })
  userType!: 'RIDER' | 'DRIVER' | 'BOTH';

  @ApiPropertyOptional({ nullable: true })
  governmentIdStatus!: string | null;

  @ApiPropertyOptional({ nullable: true })
  corporateStatus!: string | null;

  @ApiProperty({
    description:
      'Completed passenger bookings + completed rides as driver (documented semantics)',
  })
  totalRides!: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Overall average rating when at least one rating exists',
  })
  rating!: number | null;

  @ApiProperty({ enum: UserStatus })
  status!: UserStatus;

  @ApiProperty()
  bookingRestricted!: boolean;

  @ApiProperty()
  ridePublishRestricted!: boolean;

  @ApiProperty()
  createdAt!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'lastLoginAt when available (trustworthy activity signal)',
  })
  lastActiveAt!: string | null;
}

export class AdminUserDirectorySummaryDto {
  @ApiProperty()
  totalUsers!: number;

  @ApiProperty()
  activeUsers!: number;

  @ApiProperty({
    description:
      'Users with publish-eligible IDENTITY+VEHICLE verification or at least one driven ride. May overlap with riders.',
  })
  drivers!: number;

  @ApiProperty({
    description:
      'Users with at least one passenger booking. May overlap with drivers.',
  })
  riders!: number;
}

export class AdminUserPageDto {
  @ApiProperty({ type: AdminUserDirectorySummaryDto })
  summary!: AdminUserDirectorySummaryDto;

  @ApiProperty({ type: [AdminUserListItemDto] })
  items!: AdminUserListItemDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
