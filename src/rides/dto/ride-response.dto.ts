import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { RideStatus, RideType } from '../enums/ride.enums';

export class RideResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  driverId!: string;

  @ApiProperty({ format: 'uuid' })
  vehicleId!: string;

  @ApiProperty({ enum: RideType, enumName: 'RideType' })
  rideType!: RideType;

  @ApiProperty({ enum: RideStatus, enumName: 'RideStatus' })
  status!: RideStatus;

  @ApiProperty()
  source!: string;

  @ApiProperty()
  destination!: string;

  @ApiProperty({ example: '2026-08-20' })
  departureDate!: string;

  @ApiProperty({ example: '09:00:00' })
  departureTime!: string;

  @ApiProperty({ example: 3 })
  totalSeats!: number;

  @ApiProperty({ example: 3 })
  availableSeats!: number;

  @ApiProperty({
    description: 'Integer points per seat as string (bigint / 1 point = ₹1)',
    example: '250',
  })
  pricePerSeat!: string;

  @ApiPropertyOptional({
    description:
      'COMMUTE only: passenger-facing fare per seat (driver price + 10% markup). ' +
      'Driver-published base fare remains in pricePerSeat. Null for REGULAR and ASSURED.',
    nullable: true,
    example: '110',
  })
  riderPricePerSeat?: string | null;

  @ApiProperty()
  maxTwoInBackSeat!: boolean;

  @ApiProperty()
  noSmoking!: boolean;

  @ApiProperty()
  noPets!: boolean;

  @ApiProperty()
  luggageAllowed!: boolean;

  @ApiProperty({
    description:
      'When true, only verified female passengers may book (REGULAR/ASSURED). Always false for COMMUTE.',
    example: false,
  })
  womenOnly!: boolean;

  @ApiPropertyOptional({ nullable: true })
  notes!: string | null;

  @ApiPropertyOptional({
    description:
      'Owner-only Assured driver deposit percentage snapshot (null for Regular)',
    nullable: true,
    example: 5,
  })
  assuredDepositPercentage?: number | null;

  @ApiPropertyOptional({
    description:
      'Owner-only Assured driver deposit amount in points (null for Regular)',
    nullable: true,
    example: '100',
  })
  assuredDepositAmount?: string | null;

  @ApiPropertyOptional({
    description:
      'Half-time regular-seats policy for Assured rides (null until decided; effective default KEEP_ASSURED_ONLY)',
    nullable: true,
    enum: ['KEEP_ASSURED_ONLY', 'ALLOW_REGULAR_RIDERS'],
  })
  regularSeatsPolicy?: string | null;

  @ApiPropertyOptional({
    description:
      'Assured 1-hour assurance window start (HH:mm:ss). Null for Regular.',
    nullable: true,
    example: '13:00:00',
  })
  assuranceWindowStart?: string | null;

  @ApiPropertyOptional({
    description:
      'Assured 1-hour assurance window end (HH:mm:ss). Null for Regular.',
    nullable: true,
    example: '14:00:00',
  })
  assuranceWindowEnd?: string | null;

  @ApiPropertyOptional({
    description:
      'Whether the ride is currently bookable by passengers (Assured: ASSURANCE_ACTIVE with seats; Regular: PUBLISHED with seats).',
    example: true,
  })
  isBookable?: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}
