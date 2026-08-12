import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { VehicleType } from '../enums/vehicle-type.enum';

export class VehicleResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: VehicleType, enumName: 'VehicleType' })
  vehicleType!: VehicleType;

  @ApiProperty({ example: 'Honda' })
  make!: string;

  @ApiProperty({ example: 'City' })
  model!: string;

  @ApiPropertyOptional({ nullable: true, example: 'ZX' })
  variant!: string | null;

  @ApiProperty({ example: 'UP16AB1234' })
  registrationNumber!: string;

  @ApiPropertyOptional({ nullable: true, example: 2024 })
  registrationYear!: number | null;

  @ApiPropertyOptional({ nullable: true, example: 'White' })
  color!: string | null;

  @ApiProperty({ example: 5 })
  seatingCapacity!: number;

  @ApiProperty({
    description: 'Preferred/active vehicle flag (changed only via activate endpoint)',
    example: true,
  })
  isActive!: boolean;
}
