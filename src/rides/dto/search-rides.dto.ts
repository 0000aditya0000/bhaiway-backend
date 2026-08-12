import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { RideType } from '../enums/ride.enums';

export class SearchRidesDto {
  @ApiProperty({
    description: 'Case-insensitive contains match against ride source',
    example: 'Noida',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  source!: string;

  @ApiProperty({
    description: 'Case-insensitive contains match against ride destination',
    example: 'Delhi',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  destination!: string;

  @ApiProperty({
    description: 'Civil departure date (YYYY-MM-DD)',
    example: '2026-08-20',
  })
  @IsDateString({ strict: true })
  date!: string;

  @ApiPropertyOptional({
    description:
      'Local wall-clock time (HH:mm or HH:mm:ss). When set, returns rides departing at or after this time.',
    example: '09:00',
  })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, {
    message: 'time must be HH:mm or HH:mm:ss',
  })
  time?: string;

  @ApiPropertyOptional({
    description: 'Minimum available seats required',
    minimum: 1,
    maximum: 8,
    example: 2,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8)
  seats?: number;

  @ApiPropertyOptional({
    enum: RideType,
    enumName: 'RideType',
    description:
      'Optional filter. When omitted, returns both REGULAR and ASSURED published rides.',
  })
  @IsOptional()
  @IsEnum(RideType)
  rideType?: RideType;

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
