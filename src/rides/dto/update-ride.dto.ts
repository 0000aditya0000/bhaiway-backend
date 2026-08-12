import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
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

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}
