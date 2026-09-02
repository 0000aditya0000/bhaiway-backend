import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { BookingCancellationReason, BookingStatus } from '../enums/booking.enums';
import { DriverBookingItemDto } from './driver-booking-response.dto';

export class CommuteAutoCancelledBookingDto {
  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status!: BookingStatus;

  @ApiProperty({
    enum: BookingCancellationReason,
    enumName: 'BookingCancellationReason',
  })
  cancellationReason!: BookingCancellationReason;

  @ApiProperty({
    description: 'True when a full upfront fare refund was credited to the passenger',
  })
  refunded!: boolean;
}

export class CommuteBookingDriverActionResponseDto extends DriverBookingItemDto {
  @ApiProperty({
    description:
      'True when accept/reject was already applied (safe retry). False on first successful transition.',
    example: false,
  })
  alreadyApplied!: boolean;

  @ApiPropertyOptional({
    type: [CommuteAutoCancelledBookingDto],
    description:
      'Pending requests auto-cancelled because the ride became full after acceptance',
  })
  autoCancelledBookings?: CommuteAutoCancelledBookingDto[];
}
