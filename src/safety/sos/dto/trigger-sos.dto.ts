import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

import { SosCategory } from '../enums/sos.enums';

export class TriggerSosDto {
  @ApiPropertyOptional({ enum: SosCategory, enumName: 'SosCategory' })
  @IsOptional()
  @IsEnum(SosCategory)
  category?: SosCategory;

  @ApiPropertyOptional({
    description: 'Client-generated idempotency key',
    example: 'sos-retry-1',
  })
  @IsOptional()
  @IsString()
  @Length(8, 128)
  idempotencyKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  accuracy?: number;
}

export class PublishSosLocationDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  accuracy?: number;
}
