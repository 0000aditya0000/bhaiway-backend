import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { BookingStatus } from '../../bookings/enums/booking.enums';
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
    description: 'Not stored on rides yet — always null',
  })
  sourceLatitude!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Not stored on rides yet — always null',
  })
  sourceLongitude!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Not stored on rides yet — always null',
  })
  destinationLatitude!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Not stored on rides yet — always null',
  })
  destinationLongitude!: number | null;

  @ApiProperty({ example: '2026-08-20' })
  departureDate!: string;

  @ApiProperty({ example: '09:00:00' })
  departureTime!: string;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description: 'Not stored on rides yet — always null',
  })
  startedAt!: string | null;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description:
      'Null for completed rides (no completedAt column). Cancelled rides use cancelledAt when present.',
  })
  completedAt!: string | null;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
  })
  cancelledAt!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Not stored on rides yet — always null',
  })
  durationMinutes!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Not stored on rides yet — always null',
  })
  distanceKm!: number | null;

  @ApiProperty()
  totalSeats!: number;

  @ApiProperty({
    description: 'Sum of seats on PENDING/CONFIRMED/COMPLETED bookings',
  })
  bookedSeats!: number;

  @ApiProperty({
    description: 'Integer points per seat as string (1 point = ₹1)',
  })
  pricePerSeat!: string;
}

export class RideHistoryVehicleDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'make + model' })
  name!: string;

  @ApiProperty()
  make!: string;

  @ApiProperty()
  model!: string;

  @ApiPropertyOptional({ nullable: true })
  color!: string | null;

  @ApiProperty()
  registrationNumber!: string;

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
    description: 'Booking totalAmount in points (1 point = ₹1)',
    example: '500',
  })
  fare!: string;

  @ApiProperty({ example: 1 })
  seats!: number;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  bookingStatus!: BookingStatus;
}

export class RideHistoryEarningsDto {
  @ApiProperty({
    description:
      'Sum of totalAmount for COMPLETED bookings on this ride (points)',
    example: '450',
  })
  passengerTotal!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Null unless a real Assured bonus amount is available for this ride',
  })
  assuredBonus!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Null unless other real earning components exist',
  })
  otherEarnings!: string | null;

  @ApiProperty({
    description: 'passengerTotal + assuredBonus + otherEarnings (points)',
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
