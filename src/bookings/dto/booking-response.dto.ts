import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { RideStatus, RideType } from '../../rides/enums/ride.enums';
import {
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingStatus,
} from '../enums/booking.enums';

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
    description: 'Whether Assured deposit rules or Regular fare rules applied',
    enum: ['ASSURED', 'REGULAR'],
  })
  bookingMode?: string;

  @ApiPropertyOptional({ type: BookingRideSummaryDto })
  ride?: BookingRideSummaryDto;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}
