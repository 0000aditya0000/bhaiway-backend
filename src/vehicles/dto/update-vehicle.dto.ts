import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { VehicleType } from '../enums/vehicle-type.enum';

export class UpdateVehicleDto {
  @ApiPropertyOptional({ enum: VehicleType, enumName: 'VehicleType' })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;

  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  make?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  model?: string;

  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  variant?: string | null;

  @ApiPropertyOptional({
    description: 'Normalized on save (trim + uppercase)',
    minLength: 4,
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(20)
  registrationNumber?: string;

  @ApiPropertyOptional({ minimum: 1980, maximum: 2100, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1980)
  @Max(2100)
  registrationYear?: number | null;

  @ApiPropertyOptional({ maxLength: 50, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  seatingCapacity?: number;

  @ApiPropertyOptional({
    description: 'Object-storage URL reference only',
    nullable: true,
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  documentUrl?: string | null;

  @ApiPropertyOptional({ maxLength: 50, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  documentType?: string | null;

  @ApiPropertyOptional({ maxLength: 255, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  documentReference?: string | null;
}
