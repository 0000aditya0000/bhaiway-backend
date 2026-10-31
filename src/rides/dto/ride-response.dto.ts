import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  RideDirection,
  RideSeriesStatus,
  RideStatus,
  RideType,
  Weekday,
} from '../enums/ride.enums';

export class CommuteSeriesSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: RideSeriesStatus, enumName: 'RideSeriesStatus' })
  status!: RideSeriesStatus;

  @ApiProperty({ example: '2026-10-29' })
  startDate!: string;

  @ApiProperty({ example: '2026-11-04' })
  endDate!: string;

  @ApiProperty({ enum: Weekday, enumName: 'Weekday', isArray: true })
  excludedWeekdays!: Weekday[];

  @ApiProperty()
  returnEnabled!: boolean;

  @ApiPropertyOptional({ nullable: true, example: '18:30:00' })
  returnDepartureTime!: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  originalRideId!: string | null;

  @ApiProperty({
    type: () => RideResponseDto,
    isArray: true,
    description: 'All generated occurrences in this series (outbound and return).',
  })
  occurrences!: RideResponseDto[];
}

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
      'Owner-only Assured driver deposit amount in points (final payable after coupon). Null for Regular.',
    nullable: true,
    example: '100',
  })
  assuredDepositAmount?: string | null;

  @ApiPropertyOptional({
    description:
      'Pre-discount Assured driver deposit when a catalog coupon was applied',
    nullable: true,
    example: '100',
  })
  originalAssuredDepositAmount?: string | null;

  @ApiPropertyOptional({
    description: 'Catalog coupon discount applied to the Assured driver deposit',
    nullable: true,
    example: '10',
  })
  couponDiscountAmount?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Catalog coupon redemption id when a driver deposit coupon was applied',
  })
  couponRedemptionId?: string | null;

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

  @ApiProperty({
    description:
      'True when the stored geometry was explicitly selected by the driver. False for legacy rides.',
  })
  routeSelected?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Selected driving route length in meters',
  })
  routeLengthMeters?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Provider duration for the selected driving route, in seconds',
  })
  routeDurationSeconds?: number | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Commute series id when this ride was generated as an occurrence. Null for non-series rides.',
  })
  seriesId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-10-29',
    description: 'Civil occurrence date for series rides. Null for non-series rides.',
  })
  occurrenceDate?: string | null;

  @ApiPropertyOptional({
    enum: RideDirection,
    enumName: 'RideDirection',
    nullable: true,
  })
  direction?: RideDirection | null;

  @ApiPropertyOptional({
    description: 'True when this is the original outbound occurrence for the series.',
  })
  isOriginalOccurrence?: boolean;

  @ApiPropertyOptional({
    type: CommuteSeriesSummaryDto,
    nullable: true,
    description:
      'Present on commute series publish/owner responses. Omitted from nested occurrence rows to avoid recursion.',
  })
  series?: CommuteSeriesSummaryDto | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}
