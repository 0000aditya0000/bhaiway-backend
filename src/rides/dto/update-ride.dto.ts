import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { RideType } from '../enums/ride.enums';

export class UpdateRideDto {
  @ApiPropertyOptional({
    enum: RideType,
    enumName: 'RideType',
    description: 'REGULAR or ASSURED',
  })
  @IsOptional()
  @IsEnum(RideType)
  rideType?: RideType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  vehicleId?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  source?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  destination?: string;

  @ApiPropertyOptional({ example: 28.5355 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-90)
  @Max(90)
  sourceLatitude?: number;

  @ApiPropertyOptional({ example: 77.391 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-180)
  @Max(180)
  sourceLongitude?: number;

  @ApiPropertyOptional({ example: 30.3165 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-90)
  @Max(90)
  destinationLatitude?: number;

  @ApiPropertyOptional({ example: 78.0322 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-180)
  @Max(180)
  destinationLongitude?: number;

  @ApiPropertyOptional({
    description: 'Civil departure date (YYYY-MM-DD)',
    example: '2026-08-20',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  departureDate?: string;

  @ApiPropertyOptional({
    description: 'Local wall-clock departure time (HH:mm or HH:mm:ss)',
    example: '09:00',
  })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, {
    message: 'departureTime must be HH:mm or HH:mm:ss',
  })
  departureTime?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 8 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  totalSeats?: number;

  @ApiPropertyOptional({
    description: 'Integer points per seat (1 point = ₹1)',
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  pricePerSeat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  maxTwoInBackSeat?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  noSmoking?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  noPets?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  luggageAllowed?: boolean;

  @ApiPropertyOptional({
    description:
      'REGULAR/ASSURED only. Locked after the first booking. Ignored for COMMUTE.',
  })
  @IsOptional()
  @IsBoolean()
  womenOnly?: boolean;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}
