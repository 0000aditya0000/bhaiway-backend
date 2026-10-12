import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

export class CreateTrustedContactDto {
  @ApiProperty({ example: 'Rahul Gangwar', minLength: 2, maxLength: 100 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(TRUSTED_CONTACT_NAME_MIN)
  @MaxLength(TRUSTED_CONTACT_NAME_MAX)
  name!: string;

  @ApiProperty({ example: '+919876543210' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(32)
  phoneNumber!: string;

  @ApiProperty({
    enum: TrustedContactRelationship,
    enumName: 'TrustedContactRelationship',
    example: TrustedContactRelationship.BROTHER,
  })
  @IsEnum(TrustedContactRelationship)
  relationship!: TrustedContactRelationship;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Optional photo URL / storage reference. No dedicated upload API yet.',
  })
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
