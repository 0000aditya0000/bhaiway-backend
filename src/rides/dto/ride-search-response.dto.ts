import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { VehicleType } from '../../vehicles/enums/vehicle-type.enum';
import { RideDirection, RideStatus, RideType } from '../enums/ride.enums';
import { RideMatchCategory } from '../route/route-geometry';

export class RideSearchPreferencesDto {
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
  })
  womenOnly!: boolean;
}

export class RideSearchDriverRatingDto {
  @ApiProperty({
    description: 'Average star rating received as a driver (1 decimal place)',
    example: 4.5,
  })
  averageRating!: number;

  @ApiProperty({
    description: 'Number of completed ratings received as a driver',
    example: 12,
  })
  totalRatings!: number;
}

export class RideSearchDriverRecentRideDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    description: 'Departure date (YYYY-MM-DD)',
    example: '2026-09-01',
  })
  date!: string;

  @ApiProperty()
  source!: string;

  @ApiProperty()
  destination!: string;

  @ApiProperty({
    enum: [RideStatus.COMPLETED, RideStatus.CANCELLED],
    enumName: 'RideStatus',
    description: 'Terminal status only: COMPLETED or CANCELLED',
  })
  status!: RideStatus.COMPLETED | RideStatus.CANCELLED;
}

export class RideSearchDriverDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Null when the driver has no display name / profile yet',
  })
  displayName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  profilePhoto!: string | null;

  @ApiProperty({
    type: RideSearchDriverRatingDto,
    description: 'Ratings received when acting as a driver',
  })
  rating!: RideSearchDriverRatingDto;

  @ApiProperty({
    type: RideSearchDriverRecentRideDto,
    isArray: true,
    description:
      'Up to 5 most recent COMPLETED or CANCELLED rides by this driver (newest first)',
  })
  recentRides!: RideSearchDriverRecentRideDto[];
}

export class RideSearchVehicleDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: VehicleType, enumName: 'VehicleType' })
  vehicleType!: VehicleType;

  @ApiProperty()
  make!: string;

  @ApiProperty()
  model!: string;

  @ApiPropertyOptional({ nullable: true })
  variant!: string | null;

  @ApiPropertyOptional({ nullable: true })
  color!: string | null;

  @ApiProperty()
  seatingCapacity!: number;
}

export class RideSearchLocationDto {
  @ApiProperty({ example: 28.5355 })
  latitude!: number;

  @ApiProperty({ example: 77.391 })
  longitude!: number;

  @ApiPropertyOptional({ example: 'Noida' })
  name?: string;
}

export class RideSearchItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: RideType, enumName: 'RideType' })
  rideType!: RideType;

  @ApiProperty({
    enum: RideStatus,
    enumName: 'RideStatus',
    description:
      'Backend lifecycle status. Assured passenger search includes only ASSURANCE_ACTIVE.',
  })
  status!: RideStatus;

  @ApiProperty()
  source!: string;

  @ApiProperty()
  destination!: string;

  @ApiProperty({ example: '2026-08-20' })
  departureDate!: string;

  @ApiProperty({ example: '09:00:00' })
  departureTime!: string;

  @ApiProperty()
  availableSeats!: number;

  @ApiProperty()
  totalSeats!: number;

  @ApiProperty({
    description: 'Integer points per seat as string (1 point = ₹1)',
    example: '250',
  })
  pricePerSeat!: string;

  @ApiPropertyOptional({
    description:
      'COMMUTE only: passenger-facing fare per seat (driver price + 10% markup). ' +
      'Not a separate platform fee — this is the ride price riders pay. ' +
      'Null for REGULAR and ASSURED.',
    nullable: true,
    example: '110',
  })
  riderPricePerSeat?: string | null;

  @ApiPropertyOptional({
    description:
      'COMMUTE only: route match percentage (0–100). Calculated only when pickup/dropoff coordinates are supplied and corridor matching is performed. Omitted for REGULAR/ASSURED and when coordinates are absent.',
    nullable: true,
    minimum: 0,
    maximum: 100,
    example: 92,
  })
  routeMatchPercentage?: number | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Commute series id when this search hit is a generated occurrence.',
  })
  seriesId?: string | null;

  @ApiPropertyOptional({
    enum: RideDirection,
    enumName: 'RideDirection',
    nullable: true,
  })
  direction?: RideDirection | null;

  @ApiProperty({ type: RideSearchPreferencesDto })
  preferences!: RideSearchPreferencesDto;

  @ApiPropertyOptional({ nullable: true })
  notes!: string | null;

  @ApiPropertyOptional({
    description:
      'Assured ride security-deposit percentage snapshot from publish. Null for Regular rides.',
    nullable: true,
    example: 5,
  })
  assuredDepositPercentage?: number | null;

  @ApiPropertyOptional({
    description:
      'Assured ride security-deposit amount in points from publish (totalSeats × pricePerSeat × percentage). Null for Regular rides. Rider booking deposit for N seats is computed separately at booking time.',
    nullable: true,
    example: '105',
  })
  assuredDepositAmount?: string | null;

  @ApiProperty({ type: RideSearchDriverDto })
  driver!: RideSearchDriverDto;

  @ApiProperty({ type: RideSearchVehicleDto })
  vehicle!: RideSearchVehicleDto;

  @ApiPropertyOptional({
    enum: RideMatchCategory,
    enumName: 'RideMatchCategory',
    nullable: true,
    description:
      'Match category: FORWARD_ROUTE_MATCH, BACKWARD_PICKUP_MATCH, EXTENDED_DESTINATION_MATCH, or FLEXIBLE_PICKUP_AND_DESTINATION_MATCH. Null for place-name search.',
  })
  matchType?: RideMatchCategory | null;

  @ApiPropertyOptional({
    description:
      'True when the ride requires independent rider travel to driver pickup or from driver dropoff',
    example: false,
  })
  isFlexibleMatch?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Approximate independent geodesic travel distance in km (straight-line Haversine distance) from rider pickup to driver starting point (BACKWARD_PICKUP_MATCH / FLEXIBLE_PICKUP_AND_DESTINATION_MATCH only). Null otherwise.',
    example: 12.5,
  })
  pickupFlexibilityDistanceKm?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Approximate independent geodesic travel distance in km (straight-line Haversine distance) from driver dropoff to rider destination (EXTENDED_DESTINATION_MATCH / FLEXIBLE_PICKUP_AND_DESTINATION_MATCH only). Null otherwise.',
    example: 24.3,
  })
  destinationExtensionDistanceKm?: number | null;

  @ApiPropertyOptional({
    type: RideSearchLocationDto,
    nullable: true,
    description:
      'Actual driver starting location where the driver will meet the rider.',
  })
  actualDriverPickupLocation?: RideSearchLocationDto | null;

  @ApiPropertyOptional({
    type: RideSearchLocationDto,
    nullable: true,
    description:
      'Actual driver drop-off location where the driver will drop the rider.',
  })
  actualDriverDropLocation?: RideSearchLocationDto | null;

  @ApiPropertyOptional({
    description:
      'True if the rider must travel independently to reach the driver pickup point',
    example: false,
  })
  requiresIndependentPickupTravel?: boolean;

  @ApiPropertyOptional({
    description:
      'True if the rider must travel independently from the driver drop-off point to their final destination',
    example: false,
  })
  requiresIndependentDestinationTravel?: boolean;

  @ApiPropertyOptional({
    description:
      'Method used for independent travel distance calculation: ROAD_NETWORK or GEODESIC.',
    example: 'ROAD_NETWORK',
    nullable: true,
  })
  distanceCalculationMethod?: 'ROAD_NETWORK' | 'GEODESIC' | null;

  @ApiPropertyOptional({
    description:
      'True when the flexible independent driving distance was verified via the road routing provider',
    example: true,
  })
  roadDistanceVerified?: boolean;

  @ApiPropertyOptional({
    description:
      'Name of routing provider that verified road distance (e.g. google, osrm, mock). Null for normal forward matches.',
    example: 'google',
    nullable: true,
  })
  routingProvider?: string | null;
}

export class RideSearchPageDto {
  @ApiProperty({ type: RideSearchItemDto, isArray: true })
  items!: RideSearchItemDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}
