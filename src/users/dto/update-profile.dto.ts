import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { Gender } from '../entities/user-profile.entity';

export class UpdateProfileDto {
  @ApiPropertyOptional({ maxLength: 100, minLength: 1 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string | null;

  @ApiPropertyOptional({ maxLength: 150, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  displayName?: string | null;

  @ApiPropertyOptional({
    enum: Gender,
    enumName: 'Gender',
    nullable: true,
    description:
      'Not user-editable. Gender is set only from Aadhaar/IDENTITY verification. Sending this field returns 403 GENDER_LOCKED.',
    deprecated: true,
  })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender | null;

  @ApiPropertyOptional({
    description: 'ISO date string (YYYY-MM-DD)',
    example: '2000-01-01',
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  profilePhoto?: string | null;
}
