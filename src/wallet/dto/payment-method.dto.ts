import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { PaymentMethodType } from '../enums/withdrawal.enums';

export class CreatePaymentMethodDto {
  @ApiProperty({ enum: PaymentMethodType, enumName: 'PaymentMethodType' })
  @IsEnum(PaymentMethodType)
  type!: PaymentMethodType;

  @ApiPropertyOptional({ example: 'name@okbank', description: 'Required for UPI' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  upiId?: string;

  @ApiPropertyOptional({ description: 'Required for BANK_ACCOUNT' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  accountHolderName?: string;

  @ApiPropertyOptional({
    description: 'Required for BANK_ACCOUNT (9-18 digits). Stored encrypted.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  accountNumber?: string;

  @ApiPropertyOptional({ example: 'HDFC0001234', description: 'Required for BANK_ACCOUNT' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  ifscCode?: string;

  @ApiPropertyOptional({ description: 'Required for BANK_ACCOUNT' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bankName?: string;
}

export class UpdatePaymentMethodDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  upiId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  accountHolderName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  accountNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(16)
  ifscCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bankName?: string;

  @ApiPropertyOptional({ description: 'Set false to deactivate (soft delete)' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class PaymentMethodResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: PaymentMethodType, enumName: 'PaymentMethodType' })
  type!: PaymentMethodType;

  @ApiProperty({ nullable: true })
  upiId!: string | null;

  @ApiProperty({ nullable: true })
  accountHolderName!: string | null;

  @ApiProperty({ nullable: true, example: 'XXXX XXXX 1234' })
  accountNumberMasked!: string | null;

  @ApiProperty({ nullable: true })
  accountNumberLast4!: string | null;

  @ApiProperty({ nullable: true })
  ifscCode!: string | null;

  @ApiProperty({ nullable: true })
  bankName!: string | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class DeletePaymentMethodResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Row was permanently removed' })
  deleted!: boolean;

  @ApiProperty({
    description:
      'Row was kept (referenced by a withdrawal) and marked inactive instead',
  })
  deactivated!: boolean;
}
