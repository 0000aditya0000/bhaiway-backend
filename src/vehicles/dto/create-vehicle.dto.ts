import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { VehicleType } from '../enums/vehicle-type.enum';

export class CreateVehicleDto {
  @ApiProperty({ enum: VehicleType, enumName: 'VehicleType', example: VehicleType.CAR })
  @IsEnum(VehicleType)
  vehicleType!: VehicleType;

  @ApiProperty({ maxLength: 100, example: 'Honda' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  make!: string;

  @ApiProperty({ maxLength: 100, example: 'City' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model!: string;

  @ApiPropertyOptional({ maxLength: 100, example: 'ZX', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  variant?: string | null;

  @ApiProperty({
    description: 'Normalized on save (trim + uppercase)',
    minLength: 4,
    maxLength: 20,
    example: 'UP16AB1234',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(20)
  registrationNumber!: string;

  @ApiPropertyOptional({ minimum: 1980, maximum: 2100, example: 2024, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1980)
  @Max(2100)
  registrationYear?: number | null;

  @ApiPropertyOptional({ maxLength: 50, example: 'White', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string | null;

  @ApiProperty({ minimum: 1, maximum: 20, example: 5 })
  @IsInt()
  @Min(1)
  @Max(20)
  seatingCapacity!: number;

  @ApiPropertyOptional({
    description: 'Object-storage URL reference only',
    example: 'https://cdn.example.com/rc.pdf',
    nullable: true,
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  documentUrl?: string | null;

  @ApiPropertyOptional({ maxLength: 50, example: 'RC', nullable: true })
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
