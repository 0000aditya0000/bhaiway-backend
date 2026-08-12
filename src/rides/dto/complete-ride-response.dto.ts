import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { RideStatus, RideType } from '../enums/ride.enums';

export class ReleasedDepositsDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'Driver Assured deposit amount released (points), if any',
    example: '100',
  })
  driver!: string | null;

  @ApiProperty({
    description: 'Total rider Assured deposit amount released (points)',
    example: '75',
  })
  riders!: string;

  @ApiProperty({
    description: 'Number of rider deposits released',
    example: 2,
  })
  riderCount!: number;
}

export class CompleteRideResponseDto {
  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ enum: RideStatus, enumName: 'RideStatus' })
  status!: RideStatus;

  @ApiProperty({ enum: RideType, enumName: 'RideType' })
  rideType!: RideType;

  @ApiPropertyOptional({
    type: ReleasedDepositsDto,
    description: 'Present for Assured rides (amounts only; no wallet internals)',
  })
  releasedDeposits?: ReleasedDepositsDto;

  @ApiProperty({
    description: 'True when the ride was already COMPLETED (idempotent retry)',
  })
  alreadyCompleted!: boolean;
}
