import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
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
} from 'class-validator';

import { RideType, Weekday } from '../enums/ride.enums';

export class CreateRideDto {
  @ApiProperty({
    enum: RideType,
    enumName: 'RideType',
    example: RideType.REGULAR,
    description:
      'REGULAR, ASSURED, or COMMUTE. ASSURED publishing creates an atomic driver security-deposit hold. ' +
      'COMMUTE: pricePerSeat is the driver-published base fare; passengers see +10% via riderPricePerSeat in search/public APIs. ' +
      'womenOnly is supported for REGULAR and ASSURED only (ignored for COMMUTE). ' +
      'Assured requires source/destination coordinates and Idempotency-Key.',
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

  @ApiProperty({
    description:
      'Signed token from POST /rides/route-options identifying the driving route the driver selected.',
  })
  @IsString()
  @IsNotEmpty()
  routeSelectionToken!: string;

  @ApiProperty({
    description:
      'WGS84 latitude of the published source. Must match the selected route.',
    example: 28.5355,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-90)
  @Max(90)
  sourceLatitude!: number;

  @ApiProperty({
    description:
      'WGS84 longitude of the published source. Must match the selected route.',
    example: 77.391,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-180)
  @Max(180)
  sourceLongitude!: number;

  @ApiProperty({
    description:
      'WGS84 latitude of the published destination. Must match the selected route.',
    example: 30.3165,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-90)
  @Max(90)
  destinationLatitude!: number;

  @ApiProperty({
    description:
      'WGS84 longitude of the published destination. Must match the selected route.',
    example: 78.0322,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-180)
  @Max(180)
  destinationLongitude!: number;

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

  @ApiPropertyOptional({
    default: false,
    description:
      'REGULAR/ASSURED only. When true, only Aadhaar-verified female passengers may book. Ignored for COMMUTE (always false).',
  })
  @IsOptional()
  @IsBoolean()
  womenOnly?: boolean;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiPropertyOptional({
    default: false,
    description:
      'COMMUTE only. When true, generates independently bookable rides for the publishing date and the next six Asia/Kolkata calendar dates, skipping excludedWeekdays. Ignored/rejected for REGULAR and ASSURED.',
  })
  @IsOptional()
  @IsBoolean()
  recurring?: boolean;

  @ApiPropertyOptional({
    enum: Weekday,
    enumName: 'Weekday',
    isArray: true,
    description:
      'COMMUTE recurring only. Weekdays to skip inside the 7-day window. Every day is included unless listed. Duplicate values are normalized. Rejected if it excludes the publishing date.',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(Weekday, { each: true })
  excludeWeekdays?: Weekday[];

  @ApiPropertyOptional({
    default: false,
    description:
      'COMMUTE only. When true, creates a same-calendar-date return ride for every eligible outbound occurrence. Requires returnDepartureTime and returnRouteSelectionToken.',
  })
  @IsOptional()
  @IsBoolean()
  returnEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Required when returnEnabled is true. Same-day return wall-clock time; must be strictly after outbound departureTime. Overnight returns are not inferred.',
    example: '18:30',
  })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, {
    message: 'returnDepartureTime must be HH:mm or HH:mm:ss',
  })
  returnDepartureTime?: string;

  @ApiPropertyOptional({
    description:
      'Required when returnEnabled is true. Token from POST /rides/route-options using reversed origin/destination coordinates. The outbound token is not accepted.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  returnRouteSelectionToken?: string;

  @ApiPropertyOptional({
    maxLength: 255,
    description:
      'Optional place-name label for the return origin. Defaults to swapping destination when omitted.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  returnSource?: string;

  @ApiPropertyOptional({
    maxLength: 255,
    description:
      'Optional place-name label for the return destination. Defaults to swapping source when omitted.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  returnDestination?: string;
}
