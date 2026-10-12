import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { PaymentMethodType, WithdrawalStatus } from '../enums/withdrawal.enums';

export class CreateWithdrawalDto {
  @ApiProperty({
    oneOf: [{ type: 'integer' }, { type: 'string' }],
    example: '500',
    description:
      'Positive whole number of Coins (1 Coin = ₹1). Only earned (driver) Coins are withdrawable.',
  })
  @IsDefined()
  amount!: number | string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  paymentMethodId!: string;
}

export class WithdrawalListQueryDto {
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

export class AdminWithdrawalListQueryDto extends WithdrawalListQueryDto {
  @ApiPropertyOptional({ enum: WithdrawalStatus, enumName: 'WithdrawalStatus' })
  @IsOptional()
  @IsEnum(WithdrawalStatus)
  status?: WithdrawalStatus;
}

export class UpdateWithdrawalStatusDto {
  @ApiProperty({ enum: WithdrawalStatus, enumName: 'WithdrawalStatus' })
  @IsEnum(WithdrawalStatus)
  status!: WithdrawalStatus;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remarks?: string;
}

export class WithdrawalPaymentMethodDto {
  @ApiProperty({ enum: PaymentMethodType, enumName: 'PaymentMethodType' })
  type!: PaymentMethodType;

  @ApiProperty({ nullable: true })
  upiId!: string | null;

  @ApiProperty({ nullable: true })
  accountHolderName!: string | null;

  @ApiProperty({ nullable: true, example: 'XXXX XXXX 1234' })
  accountNumberMasked!: string | null;

  @ApiProperty({ nullable: true })
  ifscCode!: string | null;

  @ApiProperty({ nullable: true })
  bankName!: string | null;
}

export class WithdrawalResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'WD-7K2M9QXA' })
  referenceId!: string;

  @ApiProperty({ example: '500', description: 'Integer Coins string' })
  amount!: string;

  @ApiProperty({ enum: WithdrawalStatus, enumName: 'WithdrawalStatus' })
  status!: WithdrawalStatus;

  @ApiProperty({ example: 'MANUAL' })
  provider!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  paymentMethodId!: string | null;

  @ApiProperty({ enum: PaymentMethodType, enumName: 'PaymentMethodType' })
  paymentMethodType!: PaymentMethodType;

  @ApiProperty({ type: WithdrawalPaymentMethodDto })
  paymentMethod!: WithdrawalPaymentMethodDto;

  @ApiProperty({ nullable: true })
  adminRemarks!: string | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  processedAt!: string | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  completedAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class WithdrawalPageDto {
  @ApiProperty({ type: WithdrawalResponseDto, isArray: true })
  items!: WithdrawalResponseDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}

export class WithdrawalStatusHistoryItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: WithdrawalStatus, nullable: true })
  previousStatus!: WithdrawalStatus | null;

  @ApiProperty({ enum: WithdrawalStatus })
  newStatus!: WithdrawalStatus;

  @ApiProperty({ format: 'uuid', nullable: true })
  adminUserId!: string | null;

  @ApiProperty({ nullable: true })
  remarks!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AdminWithdrawalResponseDto extends WithdrawalResponseDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ format: 'uuid' })
  walletId!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  walletHoldId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  walletTransactionId!: string | null;

  @ApiPropertyOptional({
    description:
      'Detail endpoint only: full bank account number (decrypted) for manual payout.',
    nullable: true,
  })
  payoutAccountNumber?: string | null;

  @ApiPropertyOptional({ type: WithdrawalStatusHistoryItemDto, isArray: true })
  statusHistory?: WithdrawalStatusHistoryItemDto[];
}

export class AdminWithdrawalPageDto {
  @ApiProperty({ type: AdminWithdrawalResponseDto, isArray: true })
  items!: AdminWithdrawalResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
