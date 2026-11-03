import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { Gender } from '../entities/user-profile.entity';
import { IsCloudinaryUrl } from '../validators/is-cloudinary-url.validator';
import { IsNotLocalFileUri } from '../validators/is-not-local-file-uri.validator';

export class CreateProfileDto {
  @ApiPropertyOptional({
    maxLength: 150,
    description:
      'Full name. If provided and firstName is omitted, automatically populates firstName and lastName.',
    example: 'Aditya Gangwar',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({ maxLength: 100, example: 'Aditya' })
  @ValidateIf((o: CreateProfileDto) => !o.name)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({ maxLength: 100, example: 'Gangwar', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string | null;

  @ApiPropertyOptional({ maxLength: 150, example: 'Aditya', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  displayName?: string | null;

  @ApiPropertyOptional({
    enum: Gender,
    enumName: 'Gender',
    nullable: true,
    description:
      'Ignored for writes. Gender is set only from Aadhaar/IDENTITY verification. Sending this field returns 403 GENDER_LOCKED.',
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

  @ApiPropertyOptional({
    example: 'https://res.cloudinary.com/bhaiway/image/upload/v1234/photo.jpg',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @IsCloudinaryUrl()
  @IsNotLocalFileUri()
  profilePhoto?: string | null;

  @ApiPropertyOptional({
    description:
      'Optional contact email stored on the user account. Normalized to lowercase. Not treated as verified.',
    example: 'aditya@example.com',
    maxLength: 255,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : (value as string),
  )
  @IsEmail()
  @MaxLength(255)
  email?: string;
}
