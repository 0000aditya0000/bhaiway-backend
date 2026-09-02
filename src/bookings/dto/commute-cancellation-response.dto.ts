import { ApiProperty } from '@nestjs/swagger';

import {
  BookingCancellationReason,
  BookingPaymentStatus,
  BookingStatus,
} from '../enums/booking.enums';

export class CommuteBookingCancellationResponseDto {
  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status!: BookingStatus;

  @ApiProperty({
    enum: BookingCancellationReason,
    enumName: 'BookingCancellationReason',
    nullable: true,
  })
  cancellationReason!: BookingCancellationReason | null;

  @ApiProperty({
    enum: BookingPaymentStatus,
    enumName: 'BookingPaymentStatus',
  })
  paymentStatus!: BookingPaymentStatus;

  @ApiProperty({
    description: 'Seats restored to the ride (CONFIRMED cancellations only)',
    example: 2,
  })
  seatsRestored!: number;

  @ApiProperty({
    description: 'Full upfront fare refunded to the passenger (points/coins)',
    example: '220',
  })
  fareRefunded!: string;

  @ApiProperty({
    description: 'True when the action was already applied (idempotent retry)',
  })
  alreadyApplied!: boolean;
}
