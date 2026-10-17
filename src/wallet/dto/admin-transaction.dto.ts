import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  WalletTransactionDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from '../entities/wallet-transaction.entity';

export class AdminTransactionListQueryDto {
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

  @ApiPropertyOptional({
    description:
      'Match transaction UUID, user UUID, wallet UUID, or reference_id (ILIKE for reference).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({ enum: WalletTransactionStatus })
  @IsOptional()
  @IsEnum(WalletTransactionStatus)
  status?: WalletTransactionStatus;

  @ApiPropertyOptional({ enum: WalletTransactionDirection })
  @IsOptional()
  @IsEnum(WalletTransactionDirection)
  direction?: WalletTransactionDirection;

  @ApiPropertyOptional({ enum: WalletTransactionType })
  @IsOptional()
  @IsEnum(WalletTransactionType)
  type?: WalletTransactionType;

  @ApiPropertyOptional({
    description: 'Inclusive start (ISO date or datetime) on created_at',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    description: 'Inclusive end (ISO date or datetime) on created_at',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    enum: ['createdAt', 'amount'],
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(['createdAt', 'amount'])
  sortBy?: 'createdAt' | 'amount' = 'createdAt';

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

export class AdminReverseTransactionDto {
  @ApiProperty({
    description: 'Required audit reason for the compensating reversal',
    minLength: 3,
    maxLength: 2000,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason!: string;
}

export class AdminTransactionListItemDto {
  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Current UserProfile display name (displayName, else first+last). Null if unavailable.',
  })
  userName!: string | null;

  @ApiProperty({ format: 'uuid' })
  walletId!: string;

  @ApiProperty({ enum: WalletTransactionType })
  type!: WalletTransactionType;

  @ApiProperty({ enum: WalletTransactionDirection })
  direction!: WalletTransactionDirection;

  @ApiProperty({
    description: 'Amount in coins (integer string, 1 Coin = ₹1)',
    example: '250',
  })
  amount!: string;

  @ApiProperty({
    example: 'INR',
    description: 'Display currency (coins ≈ INR)',
  })
  currency!: string;

  @ApiProperty({ enum: WalletTransactionStatus })
  status!: WalletTransactionStatus;

  @ApiPropertyOptional({ nullable: true })
  referenceType!: string | null;

  @ApiPropertyOptional({ nullable: true })
  referenceId!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'No separate completion timestamp on the ledger; always null.',
  })
  completedAt!: string | null;

  @ApiProperty({
    description: 'True when an admin compensating reversal exists',
  })
  isReversed!: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Compensating admin reversal transaction id, if any',
  })
  reversalTransactionId!: string | null;
}

export class AdminTransactionPageDto {
  @ApiProperty({ type: AdminTransactionListItemDto, isArray: true })
  items!: AdminTransactionListItemDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

export class AdminTransactionDetailDto extends AdminTransactionListItemDto {
  @ApiPropertyOptional({ nullable: true })
  pointSource!: string | null;

  @ApiProperty({
    description: 'Wallet total balance before this row (coins)',
  })
  balanceBefore!: string;

  @ApiProperty({
    description: 'Wallet total balance after this row (coins)',
  })
  balanceAfter!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Parent ledger row when this tx is a hold child or admin reverse',
  })
  parentTransactionId!: string | null;

  @ApiProperty({
    description: 'Server idempotency key (not a secret)',
  })
  idempotencyKey!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'No free-text description column on wallet_transactions; always null.',
  })
  description!: string | null;

  @ApiProperty({
    description: 'Whether POST /reverse is currently allowed for this row',
  })
  canReverse!: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Why reverse is blocked, when canReverse is false',
  })
  reverseBlockReason!: string | null;

  @ApiPropertyOptional({
    type: AdminTransactionListItemDto,
    nullable: true,
  })
  reversalTransaction!: AdminTransactionListItemDto | null;
}

export class AdminReverseTransactionResponseDto {
  @ApiProperty({ type: AdminTransactionDetailDto })
  original!: AdminTransactionDetailDto;

  @ApiProperty({ type: AdminTransactionDetailDto })
  reversal!: AdminTransactionDetailDto;

  @ApiProperty({
    description: 'True when this call reused an existing idempotent reversal',
  })
  alreadyReversed!: boolean;
}

/** Kept for swagger ParseUUIDPipe params. */
export class AdminTransactionIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  transactionId!: string;
}
