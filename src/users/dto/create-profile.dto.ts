import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Gender } from '../entities/user-profile.entity';

export class CreateProfileDto {
  @ApiProperty({ maxLength: 100, example: 'Aditya' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName!: string;

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

  @ApiPropertyOptional({ enum: Gender, enumName: 'Gender', nullable: true })
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
    example: 'https://cdn.example.com/photo.jpg',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  profilePhoto?: string | null;

  @ApiPropertyOptional({
    description:
      'Optional contact email stored on the user account. Normalized to lowercase. Not treated as verified.',
    example: 'aditya@example.com',
    maxLength: 255,
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsEmail()
  @MaxLength(255)
  email?: string;
}
