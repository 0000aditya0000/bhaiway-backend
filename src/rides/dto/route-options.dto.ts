import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class RequestRouteOptionsDto {
  @ApiPropertyOptional({
    description: 'Place-name label for the origin (not used for routing).',
    example: 'Noida Sector 62',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  source?: string;

  @ApiPropertyOptional({
    description: 'Place-name label for the destination (not used for routing).',
    example: 'Dehradun',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  destination?: string;

  @ApiProperty({ example: 28.5355 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-90)
  @Max(90)
  sourceLatitude!: number;

  @ApiProperty({ example: 77.391 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-180)
  @Max(180)
  sourceLongitude!: number;

  @ApiProperty({ example: 30.3165 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-90)
  @Max(90)
  destinationLatitude!: number;

  @ApiProperty({ example: 78.0322 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-180)
  @Max(180)
  destinationLongitude!: number;
}

export class RouteOptionDto {
  @ApiProperty({
    description: 'Opaque signed selection token. Pass this as routeSelectionToken when publishing.',
  })
  selectionToken!: string;

  @ApiProperty({ description: 'Stable id for this option within the token lifetime' })
  optionId!: string;

  @ApiProperty({ description: 'Google-encoded driving polyline' })
  polyline!: string;

  @ApiProperty({ description: 'Route length in meters' })
  distanceMeters!: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Estimated driving duration in seconds, when the provider supplies it',
  })
  durationSeconds!: number | null;

  @ApiProperty()
  sourceLatitude!: number;

  @ApiProperty()
  sourceLongitude!: number;

  @ApiProperty()
  destinationLatitude!: number;

  @ApiProperty()
  destinationLongitude!: number;
}

export class RouteOptionsResponseDto {
  @ApiProperty({ type: RouteOptionDto, isArray: true })
  options!: RouteOptionDto[];
}
