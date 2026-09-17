import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

export class VerifyVehicleRcDto {
  @ApiPropertyOptional({
    description:
      'Vehicle registration number to verify. If omitted, vehicle.registrationNumber is used.',
    example: 'UP14AB1234',
  })
  @IsOptional()
  @IsString()
  @Length(4, 20)
  @Matches(/^[a-zA-Z0-9\s-]+$/, {
    message: 'Vehicle number must contain only alphanumeric characters, spaces, or hyphens',
  })
  vehicleNumber?: string;
}
