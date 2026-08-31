import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { RideType } from '../enums/ride.enums';

export class SearchRidesDto {
  @ApiProperty({
    description:
      'Place-name hint (case-insensitive contains). Used for legacy text search and as a soft label when coordinates are provided.',
    example: 'Noida',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  source!: string;

  @ApiProperty({
    description:
      'Place-name hint (case-insensitive contains). Used for legacy text search and as a soft label when coordinates are provided.',
    example: 'Dehradun',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  destination!: string;

  @ApiPropertyOptional({
    description:
      'Passenger pickup latitude. Provide all four coordinate fields to use 50km route-corridor matching instead of strict place-name matching.',
    example: 28.6415,
  })
  @ValidateIf(
    (dto: SearchRidesDto) =>
      dto.pickupLatitude !== undefined ||
      dto.pickupLongitude !== undefined ||
      dto.dropoffLatitude !== undefined ||
      dto.dropoffLongitude !== undefined,
  )
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-90)
  @Max(90)
  pickupLatitude?: number;

  @ApiPropertyOptional({ example: 77.372 })
  @ValidateIf(
    (dto: SearchRidesDto) =>
      dto.pickupLatitude !== undefined ||
      dto.pickupLongitude !== undefined ||
      dto.dropoffLatitude !== undefined ||
      dto.dropoffLongitude !== undefined,
  )
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-180)
  @Max(180)
  pickupLongitude?: number;

  @ApiPropertyOptional({ example: 30.3165 })
  @ValidateIf(
    (dto: SearchRidesDto) =>
      dto.pickupLatitude !== undefined ||
      dto.pickupLongitude !== undefined ||
      dto.dropoffLatitude !== undefined ||
      dto.dropoffLongitude !== undefined,
  )
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-90)
  @Max(90)
  dropoffLatitude?: number;

  @ApiPropertyOptional({ example: 78.0322 })
  @ValidateIf(
    (dto: SearchRidesDto) =>
      dto.pickupLatitude !== undefined ||
      dto.pickupLongitude !== undefined ||
      dto.dropoffLatitude !== undefined ||
      dto.dropoffLongitude !== undefined,
  )
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-180)
  @Max(180)
  dropoffLongitude?: number;

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
      'Optional filter. When omitted, returns REGULAR, COMMUTE, and ASSURED passenger-visible rides.',
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
