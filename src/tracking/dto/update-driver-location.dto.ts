import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export class UpdateDriverLocationDto {
  @ApiProperty({
    description: 'Driver latitude (WGS84)',
    example: 28.6139,
    minimum: -90,
    maximum: 90,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @ApiProperty({
    description: 'Driver longitude (WGS84)',
    example: 77.209,
    minimum: -180,
    maximum: 180,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-180)
  @Max(180)
  longitude!: number;

  @ApiPropertyOptional({
    description: 'Client GPS fix time (ISO-8601). Server clock used when omitted.',
    example: '2026-08-22T18:30:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  timestamp?: string;

  @ApiPropertyOptional({
    description: 'Compass heading in degrees (0–360). Optional.',
    example: 125,
    minimum: 0,
    maximum: 360,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(360)
  heading?: number;

  @ApiPropertyOptional({
    description: 'Ground speed in km/h (or device units). Optional; must be finite ≥ 0.',
    example: 32,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  speed?: number;
}
