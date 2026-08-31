import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { RideStatus, RideType } from '../../rides/enums/ride.enums';
import {
  BookingFarePayment,
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingPickupStatus,
  BookingStatus,
} from '../enums/booking.enums';

/** Safe co-passenger fields for the Review Booking screen. Never includes phone, email, or wallet. */
export class BookingCoPassengerDto {
  @ApiProperty({ format: 'uuid' })
  passengerId!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Profile displayName when set; otherwise firstName; null when no profile exists',
  })
  displayName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  profilePhoto!: string | null;

  @ApiProperty({ example: 1 })
  seats!: number;
}

/** Safe passenger-facing driver fields. Never includes phone, email, wallet, or documents. */
export class BookingDriverDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Profile displayName when set; otherwise firstName; null when no profile exists',
  })
  displayName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  profilePhoto!: string | null;

  @ApiProperty({
    description:
      'True when the driver currently has a non-expired IDENTITY verification with status VERIFIED',
  })
  isVerified!: boolean;
}

/** Vehicle snapshot from the ride at booking time (via ride.vehicleId). */
export class BookingVehicleSnapshotDto {
  @ApiProperty({ example: 'Tata' })
  make!: string;

  @ApiProperty({ example: 'Nexon' })
  model!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Black',
  })
  color!: string | null;

  @ApiProperty({ example: 'DL 3C AB 1234' })
  registrationNumber!: string;
}

export class BookingRideSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

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
}

export class BookingResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ format: 'uuid' })
  passengerId!: string;

  @ApiProperty({ example: 2 })
  seats!: number;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status!: BookingStatus;

  @ApiProperty({
    enum: BookingPaymentMethod,
    enumName: 'BookingPaymentMethod',
  })
  paymentMethod!: BookingPaymentMethod;

  @ApiProperty({
    enum: BookingPaymentStatus,
    enumName: 'BookingPaymentStatus',
    description: 'Fare payment status (deposit hold is independent)',
  })
  paymentStatus!: BookingPaymentStatus;

  @ApiPropertyOptional({
    enum: BookingFarePayment,
    enumName: 'BookingFarePayment',
    nullable: true,
    description:
      'Assured fare choice when paymentMethod=ASSURED_DEPOSIT. Null for Regular bookings.',
  })
  farePayment?: BookingFarePayment | null;

  @ApiPropertyOptional({
    enum: BookingPaymentStatus,
    enumName: 'BookingPaymentStatus',
    description:
      'Explicit fare payment status (same as paymentStatus). Additive for mobile Assured deposit UX.',
  })
  farePaymentStatus?: BookingPaymentStatus;

  @ApiPropertyOptional({
    description: 'Ride fare amount in points (same as totalAmount)',
    example: '700',
  })
  fareAmount?: string;

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

  @ApiPropertyOptional({
    description: 'Assured rider security deposit amount in points',
    nullable: true,
    example: '25',
  })
  securityDepositAmount?: string | null;

  @ApiPropertyOptional({
    description: 'Assured rider security deposit percentage snapshot',
    nullable: true,
    example: 5,
  })
  securityDepositPercentage?: number | null;

  @ApiPropertyOptional({
    description:
      'Why an elevated Assured deposit applies (e.g. PREVIOUS_ASSURED_CANCELLATION)',
    nullable: true,
  })
  securityDepositReason?: string | null;

  @ApiPropertyOptional({
    description:
      'Assured security deposit hold state. HELD when an ACTIVE wallet hold exists; NONE when Assured deposit was 0/waived; null for Regular.',
    enum: ['HELD', 'NONE'],
    nullable: true,
  })
  securityDepositStatus?: 'HELD' | 'NONE' | null;

  @ApiPropertyOptional({
    description: 'Whether Assured deposit rules or Regular fare rules applied',
    enum: ['ASSURED', 'REGULAR'],
  })
  bookingMode?: string;

  @ApiPropertyOptional({
    enum: BookingPickupStatus,
    enumName: 'BookingPickupStatus',
    nullable: true,
    description:
      'Regular-ride boarding state. Null for Assured / non-pickup bookings.',
  })
  pickupStatus?: BookingPickupStatus | null;

  @ApiPropertyOptional({
    description:
      '4-digit pickup OTP for the booking owner only. Null after pickup or when not applicable. Never returned on driver APIs.',
    example: '4821',
    nullable: true,
  })
  pickupOtp?: string | null;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
  })
  pickupVerifiedAt?: string | null;

  @ApiPropertyOptional({
    description: '1-based boarding order within the Regular ride',
    nullable: true,
  })
  pickupOrder?: number | null;

  @ApiPropertyOptional({ type: BookingRideSummaryDto })
  ride?: BookingRideSummaryDto;

  @ApiPropertyOptional({
    type: BookingDriverDto,
    description:
      'Safe driver summary from the ride owner. Derived from UserProfile + IDENTITY verification.',
  })
  driver?: BookingDriverDto;

  @ApiPropertyOptional({
    type: BookingVehicleSnapshotDto,
    description:
      'Vehicle snapshot for the booked ride (make/model/color/registration).',
  })
  vehicle?: BookingVehicleSnapshotDto;

  @ApiPropertyOptional({
    type: BookingCoPassengerDto,
    isArray: true,
    description:
      'Other active passengers on the same ride (GET /bookings/:id only). Excludes the booking owner. Safe public fields only.',
  })
  coPassengers?: BookingCoPassengerDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}
