import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  BookingPickupStatus,
  BookingStatus,
} from '../enums/booking.enums';

export class VerifyPickupResponseDto {
  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({ format: 'uuid' })
  rideId!: string;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status!: BookingStatus;

  @ApiProperty({
    enum: BookingPickupStatus,
    enumName: 'BookingPickupStatus',
  })
  pickupStatus!: BookingPickupStatus;

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

  @ApiProperty({
    description: 'True when pickup was already verified (idempotent retry)',
  })
  alreadyVerified!: boolean;
}
