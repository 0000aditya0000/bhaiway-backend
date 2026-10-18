import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import {
  SUPPORT_ATTACHMENT_MAX,
  SUPPORT_DESCRIPTION_MAX,
  SupportTicketCategory,
} from '../enums/support.enums';

export class CreateSupportTicketDto {
  @ApiProperty({ enum: SupportTicketCategory })
  @IsEnum(SupportTicketCategory)
  category!: SupportTicketCategory;

  @ApiProperty({
    description: 'Subcategory valid for the selected category',
    example: 'DRIVER_BEHAVIOUR',
  })
  @Transform(({ value }): string =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  subcategory!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: SUPPORT_DESCRIPTION_MAX,
  })
  @Transform(({ value }): string =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(SUPPORT_DESCRIPTION_MAX)
  description!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Required for BOOKINGS_AND_RIDES. Must be an eligible ride for the authenticated user.',
  })
  @ValidateIf(
    (o: CreateSupportTicketDto) =>
      o.category === SupportTicketCategory.BOOKINGS_AND_RIDES,
  )
  @IsUUID()
  relatedRideId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Optional wallet transaction for PAYMENTS_AND_WALLETS. Must belong to the authenticated user.',
  })
  @IsOptional()
  @IsUUID()
  relatedWalletTransactionId?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Up to 3 HTTPS JPEG/PNG/WebP screenshot URLs. Created atomically with the ticket (no separate upload staging API).',
    maxItems: SUPPORT_ATTACHMENT_MAX,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SUPPORT_ATTACHMENT_MAX)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  @Type(() => String)
  attachmentUrls?: string[];

  @ApiPropertyOptional({
    description: 'Client idempotency key to prevent duplicate ticket creation',
  })
  @IsOptional()
  @Transform(({ value }): string | undefined =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(255)
  idempotencyKey?: string;
}
