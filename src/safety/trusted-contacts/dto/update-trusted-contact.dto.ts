import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { TrustedContactRelationship } from '../enums/trusted-contact-relationship.enum';
import {
  TRUSTED_CONTACT_NAME_MAX,
  TRUSTED_CONTACT_NAME_MIN,
  TRUSTED_CONTACT_PHOTO_URL_MAX,
} from '../trusted-contact.constants';

export class UpdateTrustedContactDto {
  @ApiPropertyOptional({ example: 'Rahul', minLength: 2, maxLength: 100 })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(TRUSTED_CONTACT_NAME_MIN)
  @MaxLength(TRUSTED_CONTACT_NAME_MAX)
  name?: string;

  @ApiPropertyOptional({ example: '+919876543210' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(32)
  phoneNumber?: string;

  @ApiPropertyOptional({
    enum: TrustedContactRelationship,
    enumName: 'TrustedContactRelationship',
  })
  @IsOptional()
  @IsEnum(TrustedContactRelationship)
  relationship?: TrustedContactRelationship;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length === 0 ? null : trimmed;
    }
    return value;
  })
  @IsString()
  @MaxLength(TRUSTED_CONTACT_PHOTO_URL_MAX)
  photoUrl?: string | null;
}
