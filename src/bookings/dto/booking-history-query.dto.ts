import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

import { BookingStatus } from '../enums/booking.enums';

/** Past-booking status filter — only terminal booking states. */
export enum BookingHistoryStatusFilter {
  COMPLETED = BookingStatus.COMPLETED,
  CANCELLED = BookingStatus.CANCELLED,
}

export class BookingHistoryQueryDto {
  @ApiPropertyOptional({
    enum: BookingHistoryStatusFilter,
    enumName: 'BookingHistoryStatusFilter',
    description:
      'Filter past bookings. When omitted, returns both COMPLETED and CANCELLED.',
  })
  @IsOptional()
  @IsEnum(BookingHistoryStatusFilter)
  status?: BookingHistoryStatusFilter;

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
