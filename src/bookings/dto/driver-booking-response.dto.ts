import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { RideStatus, RideType } from '../../rides/enums/ride.enums';
import {
  BookingMode,
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingPickupStatus,
  BookingStatus,
} from '../enums/booking.enums';

/** Safe passenger fields for driver-facing booking lists. */
export class DriverBookingPassengerDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Null when the passenger has no profile yet',
  })
  firstName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  lastName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  displayName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  profilePhoto!: string | null;
}

export class DriverBookingRideDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  source!: string;

  @ApiProperty()
  destination!: string;

  @ApiProperty({ example: '2026-08-20' })
  departureDate!: string;

  @ApiProperty({ example: '09:00:00' })
  departureTime!: string;

  @ApiProperty({ enum: RideType, enumName: 'RideType' })
  rideType!: RideType;

  @ApiProperty({ enum: RideStatus, enumName: 'RideStatus' })
  status!: RideStatus;
}

export class DriverBookingItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ type: DriverBookingPassengerDto })
  passenger!: DriverBookingPassengerDto;

  @ApiProperty({ example: 2 })
  seats!: number;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status!: BookingStatus;

  @ApiPropertyOptional({
    enum: BookingPickupStatus,
    enumName: 'BookingPickupStatus',
    nullable: true,
    description:
      'Regular-ride boarding state. Null when not applicable. Never includes OTP.',
  })
  pickupStatus!: BookingPickupStatus | null;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
  })
  pickupVerifiedAt!: string | null;

  @ApiPropertyOptional({
    description: '1-based boarding order within the ride',
    nullable: true,
  })
  pickupOrder!: number | null;

  @ApiProperty({ enum: BookingMode, enumName: 'BookingMode' })
  bookingMode!: BookingMode;

  @ApiProperty({
    enum: BookingPaymentMethod,
    enumName: 'BookingPaymentMethod',
  })
  paymentMethod!: BookingPaymentMethod;

  @ApiProperty({
    enum: BookingPaymentStatus,
    enumName: 'BookingPaymentStatus',
  })
  paymentStatus!: BookingPaymentStatus;

  @ApiProperty({
    description: 'Integer points per seat snapshot (1 point = ₹1)',
    example: '250',
  })
  pricePerSeatSnapshot!: string;

  @ApiProperty({
    description: 'Integer points total (snapshot × seats)',
    example: '500',
  })
  totalAmount!: string;

  @ApiProperty({ type: DriverBookingRideDto })
  ride!: DriverBookingRideDto;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class DriverBookingPageDto {
  @ApiProperty({ type: DriverBookingItemDto, isArray: true })
  items!: DriverBookingItemDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}
