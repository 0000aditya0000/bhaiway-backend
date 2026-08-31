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

export class CommuteSettlementSummaryDto {
  @ApiProperty({
    description: 'Number of CONFIRMED Commute bookings settled at completion',
    example: 2,
  })
  settledBookingCount!: number;

  @ApiProperty({
    description: 'Total driver share credited (integer points)',
    example: '300',
  })
  driverSettlementTotal!: string;

  @ApiProperty({
    description:
      'Total BhaiWay margin credited (integer points; not a separate platform fee)',
    example: '30',
  })
  platformMarginTotal!: string;
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

  @ApiPropertyOptional({
    type: CommuteSettlementSummaryDto,
    description:
      'Present for Commute rides after completion settlement. Rider fare was already paid at request time.',
  })
  commuteSettlement?: CommuteSettlementSummaryDto;

  @ApiProperty({
    description: 'True when the ride was already COMPLETED (idempotent retry)',
  })
  alreadyCompleted!: boolean;
}
