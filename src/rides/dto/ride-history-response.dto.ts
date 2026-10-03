import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { BookingStatus } from '../../bookings/enums/booking.enums';
import { VehicleType } from '../../vehicles/enums/vehicle-type.enum';
import { RideStatus, RideType } from '../enums/ride.enums';

export class RideHistoryTripDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: RideStatus, enumName: 'RideStatus' })
  status!: RideStatus;

  @ApiProperty({ enum: RideType, enumName: 'RideType' })
  rideType!: RideType;

  @ApiProperty()
  source!: string;

  @ApiProperty()
  destination!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Stored ride source latitude when available',
  })
  sourceLatitude!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Stored ride source longitude when available',
  })
  sourceLongitude!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Stored ride destination latitude when available',
  })
  destinationLatitude!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Stored ride destination longitude when available',
  })
  destinationLongitude!: number | null;

  @ApiProperty({ example: '2026-08-20' })
  departureDate!: string;

  @ApiProperty({ example: '09:00:00' })
  departureTime!: string;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description:
      'Earliest passenger pickup verification time on this ride, when available',
  })
  startedAt!: string | null;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description:
      'Set when the ride moves to COMPLETED. Cancelled rides use cancelledAt.',
  })
  completedAt!: string | null;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
  })
  cancelledAt!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Trip duration in whole minutes from earliest pickup verification to completedAt, when both exist',
  })
  durationMinutes!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Route distance in km derived from stored routeLengthMeters (null when route geometry was not stored)',
    example: 12.45,
  })
  distanceKm!: number | null;

  @ApiProperty()
  totalSeats!: number;

  @ApiProperty({
    description: 'Sum of seats on PENDING/CONFIRMED/COMPLETED bookings',
  })
  bookedSeats!: number;

  @ApiProperty({
    description: 'Integer points per seat as string (1 Coin = ₹1)',
  })
  pricePerSeat!: string;
}

export class RideHistoryVehicleDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'make + model' })
  name!: string;

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
  registrationNumber!: string;

  @ApiPropertyOptional({ nullable: true })
  registrationYear!: number | null;

  @ApiProperty()
  seatingCapacity!: number;

  @ApiProperty({
    description:
      'True when the vehicle owner currently has a non-expired VEHICLE verification VERIFIED',
  })
  isVerified!: boolean;
}

export class RideHistoryPassengerDto {
  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiPropertyOptional({ nullable: true })
  name!: string | null;

  @ApiPropertyOptional({ nullable: true })
  profileImage!: string | null;

  @ApiProperty({
    description: 'Booking totalAmount in points (1 Coin = ₹1)',
    example: '500',
  })
  fare!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Driver share of this booking when a split exists (e.g. Commute). Null for full-fare Regular/Assured bookings.',
    example: '136',
  })
  driverShare!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Platform share of this booking when a split exists (e.g. Commute margin). Null otherwise.',
    example: '14',
  })
  platformShare!: string | null;

  @ApiProperty({ example: 1 })
  seats!: number;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  bookingStatus!: BookingStatus;
}

export class RideHistoryEarningsDto {
  @ApiProperty({
    description:
      'Sum of totalAmount for COMPLETED bookings on this ride (points paid by passengers)',
    example: '450',
  })
  passengerTotal!: string;

  @ApiProperty({
    description:
      'Driver share of COMPLETED bookings (uses driverShareAmount when set, otherwise full booking totalAmount)',
    example: '408',
  })
  driverShare!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Platform share of COMPLETED bookings when fare splits exist (e.g. Commute). Null when there is no platform cut.',
    example: '42',
  })
  platformShare!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Assured partial-fill / assurance compensation credited to the driver for this ride, when present',
  })
  assuredBonus!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Other driver credits tied to this ride (e.g. passenger-cancel Assured compensation), when present',
  })
  otherEarnings!: string | null;

  @ApiProperty({
    description:
      'Net driver earnings for this ride: driverShare + assuredBonus + otherEarnings (points)',
    example: '450',
  })
  total!: string;
}

/** List-row summary for driver past rides. */
export class RideHistoryListItemDto {
  @ApiProperty({ type: RideHistoryTripDto })
  ride!: RideHistoryTripDto;

  @ApiPropertyOptional({ type: RideHistoryVehicleDto, nullable: true })
  vehicle!: RideHistoryVehicleDto | null;

  @ApiProperty({ type: RideHistoryEarningsDto })
  earnings!: RideHistoryEarningsDto;

  @ApiProperty({ example: 2 })
  passengerCount!: number;
}

export class RideHistoryDetailDto {
  @ApiProperty({ type: RideHistoryTripDto })
  ride!: RideHistoryTripDto;

  @ApiPropertyOptional({ type: RideHistoryVehicleDto, nullable: true })
  vehicle!: RideHistoryVehicleDto | null;

  @ApiProperty({ type: RideHistoryPassengerDto, isArray: true })
  passengers!: RideHistoryPassengerDto[];

  @ApiProperty({ type: RideHistoryEarningsDto })
  earnings!: RideHistoryEarningsDto;
}

export class RideHistoryPageDto {
  @ApiProperty({ type: RideHistoryListItemDto, isArray: true })
  items!: RideHistoryListItemDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}
