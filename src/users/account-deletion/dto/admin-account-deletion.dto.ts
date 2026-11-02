import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  AccountDeletionRequestStatus,
  DeletionReason,
} from '../enums/account-deletion.enums';

export enum AdminAccountDeletionSortField {
  REQUESTED_AT = 'requestedAt',
  RESPONSE_DUE_AT = 'responseDueAt',
  CREATED_AT = 'createdAt',
  STATUS = 'status',
}

export class AdminAccountDeletionListQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: AccountDeletionRequestStatus })
  @IsOptional()
  @IsEnum(AccountDeletionRequestStatus)
  status?: AccountDeletionRequestStatus;

  @ApiPropertyOptional({
    description: 'Search by user phone, email, name, user ID or request ID',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter requests submitted on or after this date (ISO string)',
  })
  @IsOptional()
  @IsString()
  dateFrom?: string;

  @ApiPropertyOptional({
    description:
      'Filter requests submitted on or before this date (ISO string)',
  })
  @IsOptional()
  @IsString()
  dateTo?: string;

  @ApiPropertyOptional({
    enum: AdminAccountDeletionSortField,
    default: AdminAccountDeletionSortField.REQUESTED_AT,
  })
  @IsOptional()
  @IsEnum(AdminAccountDeletionSortField)
  sortBy?: AdminAccountDeletionSortField =
    AdminAccountDeletionSortField.REQUESTED_AT;

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

export class AdminRequestUserActionDto {
  @ApiProperty({
    description:
      'User-facing message explaining what action is required before deletion can proceed',
    example: 'Please withdraw your remaining wallet balance of ₹250.',
  })
  @IsString()
  @IsNotEmpty({ message: 'User action explanation is required' })
  @MaxLength(1000)
  message!: string;

  @ApiPropertyOptional({
    description: 'Optional internal note visible only to admins',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  adminNote?: string;
}

export class AdminReviewDeletionDto {
  @ApiPropertyOptional({
    description: 'Optional internal note visible only to admins',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  adminNote?: string;
}

export class AdminApproveDeletionDto {
  @ApiPropertyOptional({
    description: 'Optional internal note visible only to admins',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  adminNote?: string;
}

export class AdminCompleteDeletionDto {
  @ApiPropertyOptional({
    description: 'Optional internal note visible only to admins',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  adminNote?: string;
}

export class AdminAccountDeletionListItemDto {
  id!: string;
  userId!: string;
  userPhone!: string | null;
  userEmail!: string | null;
  userDisplayName!: string | null;
  userStatus!: string;
  reason!: DeletionReason;
  status!: AccountDeletionRequestStatus;
  userActionRequired!: boolean;
  requestedAt!: Date;
  responseDueAt!: Date;
  createdAt!: Date;
}

export class AdminAccountDeletionStatusCountsDto {
  total!: number;
  pending!: number;
  underReview!: number;
  actionRequired!: number;
  approved!: number;
  completed!: number;
  cancelled!: number;
}

export class AdminAccountDeletionPageDto {
  items!: AdminAccountDeletionListItemDto[];
  total!: number;
  page!: number;
  limit!: number;
  totalPages!: number;
  statusCounts!: AdminAccountDeletionStatusCountsDto;
}
