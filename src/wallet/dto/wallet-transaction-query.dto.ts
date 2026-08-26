import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

import { WalletTransactionType } from '../entities/wallet-transaction.entity';

export class WalletTransactionQueryDto {
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

  @ApiPropertyOptional({
    enum: WalletTransactionType,
    enumName: 'WalletTransactionType',
    description: 'Filter by ledger transaction type',
  })
  @IsOptional()
  @IsEnum(WalletTransactionType)
  transactionType?: WalletTransactionType;

  @ApiPropertyOptional({
    description: 'Inclusive start date (YYYY-MM-DD) on created_at',
    example: '2026-08-01',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    description: 'Inclusive end date (YYYY-MM-DD) on created_at',
    example: '2026-08-31',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;
}
