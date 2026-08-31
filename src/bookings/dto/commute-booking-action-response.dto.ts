import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { DriverBookingItemDto } from './driver-booking-response.dto';

export class CommuteBookingDriverActionResponseDto extends DriverBookingItemDto {
  @ApiProperty({
    description:
      'True when accept/reject was already applied (safe retry). False on first successful transition.',
    example: false,
  })
  alreadyApplied!: boolean;
}
