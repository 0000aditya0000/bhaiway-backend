import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { BookingStatus } from '../enums/booking.enums';

export class DriverBookingsQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'When set, return bookings only for this ride. The ride must belong to the authenticated driver.',
  })
  @IsOptional()
  @IsUUID()
  rideId?: string;

  @ApiPropertyOptional({
    enum: BookingStatus,
    enumName: 'BookingStatus',
    description: 'Filter by booking status. Cancelled/completed are included when selected.',
  })
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}
