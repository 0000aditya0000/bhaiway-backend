import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  BookingCancellationReason,
  BookingFarePayment,
  BookingPaymentStatus,
  BookingStatus,
} from '../../bookings/enums/booking.enums';
import {
  RegularSeatsPolicy,
  RideCancellationReason,
  RideStatus,
} from '../../rides/enums/ride.enums';

export class AssuredRideLifecycleResponseDto {
  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ enum: RideStatus, enumName: 'RideStatus' })
  status!: RideStatus;

  @ApiPropertyOptional({
    enum: RideCancellationReason,
    enumName: 'RideCancellationReason',
    nullable: true,
  })
  cancellationReason!: RideCancellationReason | null;

  @ApiProperty({
    description: 'Number of bookings cancelled as part of this lifecycle action',
  })
  cancelledBookingCount!: number;

  @ApiPropertyOptional({
    description:
      'Driver Assured deposit forfeited (points). Null when no deposit was consumed.',
    nullable: true,
    example: '100',
  })
  driverDepositForfeited!: string | null;

  @ApiProperty({
    description: 'Total compensation credited to Assured riders (points)',
    example: '60',
  })
  riderCompensationTotal!: string;

  @ApiProperty({
    description: 'Platform forfeiture credit (points)',
    example: '40',
  })
  platformForfeiture!: string;

  @ApiProperty({
    description:
      'Total Assured PAY_NOW fare refunded to passengers on driver cancellation (points). Zero for driver no-show or when no PAY_NOW bookings existed.',
    example: '500',
  })
  fareRefundedTotal!: string;

  @ApiProperty({
    description:
      'Number of NEXT_ASSURED_DEPOSIT_FREE coupons issued to confirmed passengers (driver cancellation only).',
    example: 2,
  })
  couponsIssuedCount!: number;

  @ApiProperty({
    description: 'True when the action was already applied (idempotent retry)',
  })
  alreadyApplied!: boolean;
}

export class AssuredBookingLifecycleResponseDto {
  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status!: BookingStatus;

  @ApiPropertyOptional({
    enum: BookingCancellationReason,
    enumName: 'BookingCancellationReason',
    nullable: true,
  })
  cancellationReason!: BookingCancellationReason | null;

  @ApiProperty({ description: 'Seats restored to the ride inventory' })
  seatsRestored!: number;

  @ApiPropertyOptional({
    description:
      'Partial-fill compensation paid to the driver (points), if applicable',
    nullable: true,
    example: '250',
  })
  partialFillCompensation!: string | null;

  @ApiPropertyOptional({
    description: 'True when a next-Assured-deposit-free coupon was issued',
  })
  couponIssued?: boolean;

  @ApiPropertyOptional({
    description: 'Assured security deposit forfeited on passenger cancellation (points)',
    example: '35',
  })
  securityDepositForfeited?: string | null;

  @ApiPropertyOptional({
    enum: BookingFarePayment,
    enumName: 'BookingFarePayment',
    nullable: true,
    description: 'Assured fare choice when applicable',
  })
  farePayment?: BookingFarePayment | null;

  @ApiPropertyOptional({
    description: 'Fare refunded to passenger on cancellation (always 0 for Phase 1)',
    example: '0',
  })
  fareRefunded?: string;

  @ApiPropertyOptional({
    description: 'Total credited to the ride driver (deposit + fare share)',
    example: '245',
  })
  driverCompensation?: string;

  @ApiPropertyOptional({
    description: 'Platform share from passenger cancellation (fare only)',
    example: '490',
  })
  platformAmount?: string;

  @ApiPropertyOptional({
    description:
      'Elevated Assured deposit percentage for the passenger next booking after self-cancel',
    example: 10,
  })
  nextAssuredDepositPercentage?: number | null;

  @ApiProperty({
    description: 'True when the action was already applied (idempotent retry)',
  })
  alreadyApplied!: boolean;
}

export class HalfTimeDecisionResponseDto {
  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({
    enum: RegularSeatsPolicy,
    enumName: 'RegularSeatsPolicy',
  })
  policy!: RegularSeatsPolicy;

  @ApiProperty({
    format: 'date-time',
    description: 'When the half-time policy was persisted',
  })
  decidedAt!: string;

  @ApiProperty({
    description: 'True when the same policy was already recorded (idempotent)',
  })
  alreadyApplied!: boolean;
}
