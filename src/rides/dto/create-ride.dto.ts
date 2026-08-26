import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { RideType } from '../enums/ride.enums';

export class CreateRideDto {
  @ApiProperty({
    enum: RideType,
    enumName: 'RideType',
    example: RideType.REGULAR,
    description:
      'REGULAR or ASSURED. ASSURED publishing creates an atomic driver security-deposit hold using the admin deposit percentage. Assured requires source/destination coordinates and Idempotency-Key.',
  })
  @IsEnum(RideType)
  rideType!: RideType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  vehicleId!: string;

  @ApiProperty({ maxLength: 255, example: 'Noida Sector 62' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  source!: string;

  @ApiProperty({ maxLength: 255, example: 'Connaught Place, Delhi' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  destination!: string;

  @ApiPropertyOptional({
    description:
      'WGS84 latitude of the published source. Required for ASSURED. For REGULAR, provide all four coordinate fields to enable route-corridor search.',
    example: 28.5355,
  })
  @ValidateIf(
    (o: CreateRideDto) =>
      o.rideType === RideType.ASSURED || o.sourceLatitude !== undefined,
  )
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-90)
  @Max(90)
  sourceLatitude?: number;

  @ApiPropertyOptional({
    description:
      'WGS84 longitude of the published source. Required for ASSURED.',
    example: 77.391,
  })
  @ValidateIf(
    (o: CreateRideDto) =>
      o.rideType === RideType.ASSURED || o.sourceLongitude !== undefined,
  )
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-180)
  @Max(180)
  sourceLongitude?: number;

  @ApiPropertyOptional({
    description:
      'WGS84 latitude of the published destination. Required for ASSURED.',
    example: 30.3165,
  })
  @ValidateIf(
    (o: CreateRideDto) =>
      o.rideType === RideType.ASSURED || o.destinationLatitude !== undefined,
  )
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-90)
  @Max(90)
  destinationLatitude?: number;

  @ApiPropertyOptional({
    description:
      'WGS84 longitude of the published destination. Required for ASSURED.',
    example: 78.0322,
  })
  @ValidateIf(
    (o: CreateRideDto) =>
      o.rideType === RideType.ASSURED || o.destinationLongitude !== undefined,
  )
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-180)
  @Max(180)
  destinationLongitude?: number;

  @ApiProperty({
    description: 'Civil departure date (YYYY-MM-DD), no timezone conversion',
    example: '2026-08-20',
  })
  @IsDateString({ strict: true })
  departureDate!: string;

  @ApiProperty({
    description: 'Local wall-clock departure time (HH:mm or HH:mm:ss)',
    example: '09:00',
  })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, {
    message: 'departureTime must be HH:mm or HH:mm:ss',
  })
  departureTime!: string;

  @ApiProperty({ minimum: 1, maximum: 8, example: 3 })
  @IsInt()
  @Min(1)
  @Max(8)
  totalSeats!: number;

  @ApiProperty({
    description: 'Integer points per seat (1 point = ₹1). No decimals.',
    minimum: 0,
    example: 250,
  })
  @IsInt()
  @Min(0)
  pricePerSeat!: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  maxTwoInBackSeat?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  noSmoking?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  noPets?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  luggageAllowed?: boolean;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}
