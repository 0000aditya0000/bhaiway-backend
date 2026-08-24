import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { RideStatus, RideType } from '../../rides/enums/ride.enums';
import {
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingPickupStatus,
  BookingStatus,
} from '../enums/booking.enums';

export class BookingHistoryTripDto {
  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  bookingStatus!: BookingStatus;

  @ApiProperty({ enum: RideStatus, enumName: 'RideStatus' })
  rideStatus!: RideStatus;

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
    description: 'pickupVerifiedAt when the passenger was boarded',
  })
  pickedUpAt!: string | null;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description: 'Not stored as dropoff time — always null',
  })
  droppedOffAt!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Not stored — always null',
  })
  durationMinutes!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Not stored — always null',
  })
  distanceKm!: number | null;

  @ApiPropertyOptional({
    enum: BookingPickupStatus,
    enumName: 'BookingPickupStatus',
    nullable: true,
  })
  pickupStatus!: BookingPickupStatus | null;

  @ApiProperty({ example: 1 })
  seats!: number;
}

export class BookingHistoryDriverDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ nullable: true })
  name!: string | null;

  @ApiPropertyOptional({ nullable: true })
  profileImage!: string | null;

  @ApiProperty({
    description:
      'True when the driver currently has a non-expired IDENTITY verification VERIFIED',
  })
  isVerified!: boolean;
}

export class BookingHistoryVehicleDto {
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

export class BookingHistoryFareBreakdownDto {
  @ApiProperty({
    description: 'Booking totalAmount in points (1 point = ₹1)',
    example: '500',
  })
  rideFare!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Not modeled separately — always null',
  })
  platformFee!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Not modeled separately — always null',
  })
  taxes!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Not modeled separately — always null',
  })
  promoDiscount!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Assured security deposit amount when present',
    example: '25',
  })
  securityDeposit!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Not modeled separately — always null',
  })
  otherCharges!: string | null;

  @ApiProperty({
    description:
      'Amount considered paid for display: totalAmount when paymentStatus is PAID, otherwise "0"',
    example: '500',
  })
  totalPaid!: string;
}

export class BookingHistoryPaymentDto {
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

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Wallet ledger transaction id when linked',
  })
  transactionId!: string | null;
}

export class BookingHistoryInvoiceDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'No invoice system exists — always null',
  })
  invoiceId!: string | null;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description: 'No invoice system exists — always null',
  })
  invoiceDate!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Mirrors payment.transactionId when present',
  })
  paymentReference!: string | null;
}

export class BookingHistoryListItemDto {
  @ApiProperty({ type: BookingHistoryTripDto })
  trip!: BookingHistoryTripDto;

  @ApiPropertyOptional({ type: BookingHistoryDriverDto, nullable: true })
  driver!: BookingHistoryDriverDto | null;

  @ApiPropertyOptional({ type: BookingHistoryVehicleDto, nullable: true })
  vehicle!: BookingHistoryVehicleDto | null;

  @ApiProperty({ type: BookingHistoryFareBreakdownDto })
  fare!: BookingHistoryFareBreakdownDto;

  @ApiProperty({ format: 'date-time' })
  bookedAt!: string;
}

export class BookingHistoryDetailDto {
  @ApiProperty({ type: BookingHistoryTripDto })
  trip!: BookingHistoryTripDto;

  @ApiPropertyOptional({ type: BookingHistoryDriverDto, nullable: true })
  driver!: BookingHistoryDriverDto | null;

  @ApiPropertyOptional({ type: BookingHistoryVehicleDto, nullable: true })
  vehicle!: BookingHistoryVehicleDto | null;

  @ApiProperty({ type: BookingHistoryFareBreakdownDto })
  fare!: BookingHistoryFareBreakdownDto;

  @ApiProperty({ type: BookingHistoryPaymentDto })
  payment!: BookingHistoryPaymentDto;

  @ApiProperty({ type: BookingHistoryInvoiceDto })
  invoice!: BookingHistoryInvoiceDto;

  @ApiProperty({ format: 'date-time' })
  bookedAt!: string;
}

export class BookingHistoryPageDto {
  @ApiProperty({ type: BookingHistoryListItemDto, isArray: true })
  items!: BookingHistoryListItemDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}
