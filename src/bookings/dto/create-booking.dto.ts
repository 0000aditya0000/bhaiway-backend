import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsUUID, Max, Min } from 'class-validator';

import { BookingPaymentMethod } from '../enums/booking.enums';

export class CreateBookingDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  rideId!: string;

  @ApiProperty({ minimum: 1, maximum: 8, example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8)
  seats!: number;

  @ApiProperty({
    enum: BookingPaymentMethod,
    enumName: 'BookingPaymentMethod',
    example: BookingPaymentMethod.PAY_LATER,
  })
  @IsEnum(BookingPaymentMethod)
  paymentMethod!: BookingPaymentMethod;
}
