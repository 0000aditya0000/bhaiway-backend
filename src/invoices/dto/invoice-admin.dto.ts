import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { RideType } from '../../rides/enums/ride.enums';
import {
  InvoiceEmailStatus,
  InvoicePlaceOfSupplyMode,
  InvoiceTaxConfigStatus,
  InvoiceTaxPricingMode,
} from '../enums/invoice.enums';
import {
  GSTIN_PATTERN,
  INDIAN_STATE_CODE_PATTERN,
  INVOICE_PREFIX_MAX,
  INVOICE_RATE_BP_MAX,
  INVOICE_RATE_BP_MIN,
  SAC_PATTERN,
} from '../invoice.constants';

export class UpsertInvoiceIssuerDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  legalName!: string;

  @ApiProperty({ example: '27AAAAA0000A1Z5' })
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(GSTIN_PATTERN, { message: 'GSTIN must be a valid 15-character GSTIN' })
  gstin!: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  addressLine1!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine2?: string | null;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  city!: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  state!: string;

  @ApiProperty({ example: '27' })
  @IsString()
  @Matches(INDIAN_STATE_CODE_PATTERN, {
    message: 'stateCode must be a valid Indian GST state code',
  })
  stateCode!: string;

  @ApiProperty()
  @IsString()
  @Matches(/^[1-9][0-9]{5}$/, { message: 'pinCode must be a 6-digit Indian PIN' })
  pinCode!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  contactEmail?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  contactPhone?: string | null;

  @ApiProperty({ example: 'BW' })
  @IsString()
  @MinLength(2)
  @MaxLength(INVOICE_PREFIX_MAX)
  @Matches(/^[A-Z0-9-]+$/, {
    message: 'invoicePrefix must be uppercase letters, digits, or hyphen',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  invoicePrefix!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  footerNotes?: string | null;
}

export class CreateInvoiceTaxConfigDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  serviceCategory!: string;

  @ApiProperty({ enum: RideType, isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(RideType, { each: true })
  rideTypes!: RideType[];

  @ApiProperty()
  @IsString()
  @Matches(SAC_PATTERN, { message: 'sacCode must be a 4–6 digit SAC' })
  sacCode!: string;

  @ApiProperty({
    description: 'GST rate in basis points. 1800 = 18.00%. Must be confirmed by tax advice.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(INVOICE_RATE_BP_MIN)
  @Max(INVOICE_RATE_BP_MAX)
  gstRateBasisPoints!: number;

  @ApiProperty({ enum: InvoiceTaxPricingMode })
  @IsEnum(InvoiceTaxPricingMode)
  pricingMode!: InvoiceTaxPricingMode;

  @ApiProperty({ enum: InvoicePlaceOfSupplyMode })
  @IsEnum(InvoicePlaceOfSupplyMode)
  placeOfSupplyMode!: InvoicePlaceOfSupplyMode;

  @ApiProperty()
  @IsISO8601()
  effectiveFrom!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  effectiveTo?: string | null;

  @ApiPropertyOptional({ enum: InvoiceTaxConfigStatus })
  @IsOptional()
  @IsEnum(InvoiceTaxConfigStatus)
  status?: InvoiceTaxConfigStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class UpdateInvoiceTaxConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  serviceCategory?: string;

  @ApiPropertyOptional({ enum: RideType, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(RideType, { each: true })
  rideTypes?: RideType[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(SAC_PATTERN, { message: 'sacCode must be a 4–6 digit SAC' })
  sacCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(INVOICE_RATE_BP_MIN)
  @Max(INVOICE_RATE_BP_MAX)
  gstRateBasisPoints?: number;

  @ApiPropertyOptional({ enum: InvoiceTaxPricingMode })
  @IsOptional()
  @IsEnum(InvoiceTaxPricingMode)
  pricingMode?: InvoiceTaxPricingMode;

  @ApiPropertyOptional({ enum: InvoicePlaceOfSupplyMode })
  @IsOptional()
  @IsEnum(InvoicePlaceOfSupplyMode)
  placeOfSupplyMode?: InvoicePlaceOfSupplyMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  effectiveTo?: string | null;

  @ApiPropertyOptional({ enum: InvoiceTaxConfigStatus })
  @IsOptional()
  @IsEnum(InvoiceTaxConfigStatus)
  status?: InvoiceTaxConfigStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class AdminInvoiceListQueryDto {
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

  @ApiPropertyOptional({ enum: InvoiceEmailStatus })
  @IsOptional()
  @IsEnum(InvoiceEmailStatus)
  emailStatus?: InvoiceEmailStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(48)
  invoiceNumber?: string;
}

export class RiderInvoiceListQueryDto {
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
    format: 'uuid',
    description: 'Limit to invoices for this completed ride',
  })
  @IsOptional()
  @IsUUID()
  rideId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Limit to the invoice for this completed booking',
  })
  @IsOptional()
  @IsUUID()
  bookingId?: string;
}

export class RiderInvoiceItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  invoiceNumber!: string;

  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Completed booking UUID (same as GET /bookings/:id id)',
  })
  bookingId!: string;

  @ApiProperty()
  rideType!: string;

  @ApiProperty()
  source!: string;

  @ApiProperty()
  destination!: string;

  @ApiProperty({ format: 'date-time' })
  issuedAt!: string;

  @ApiProperty({ example: '210.50' })
  invoiceTotal!: string;

  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty()
  paymentStatus!: string;

  @ApiProperty()
  emailStatus!: string;

  @ApiProperty({
    type: Boolean,
    example: true,
    description:
      'Always true for issued rider invoices. Download with GET /invoices/:id/pdf.',
  })
  pdfAvailable!: boolean;
}

export class RiderInvoiceListResponseDto {
  @ApiProperty({ type: RiderInvoiceItemDto, isArray: true })
  items!: RiderInvoiceItemDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;
}
