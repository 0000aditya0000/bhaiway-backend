import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import {
  BookingFarePayment,
  BookingPaymentMethod,
} from '../enums/booking.enums';

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
    description:
      'REGULAR: PAY_NOW or PAY_LATER. COMMUTE: always charged upfront (send PAY_NOW; paymentMethod is ignored except ASSURED_DEPOSIT is rejected). ' +
      'ASSURED deposit booking: ASSURED_DEPOSIT (mandatory). After ALLOW_REGULAR_RIDERS, remaining Assured seats may use PAY_NOW/PAY_LATER without deposit.',
  })
  @IsEnum(BookingPaymentMethod)
  paymentMethod!: BookingPaymentMethod;

  @ApiPropertyOptional({
    enum: BookingFarePayment,
    enumName: 'BookingFarePayment',
    description:
      'Assured fare choice when paymentMethod=ASSURED_DEPOSIT. PAY_NOW debits fare immediately after the deposit hold; PAY_LATER leaves fare UNPAID. Omitted defaults to PAY_LATER. Not allowed for Regular payment methods.',
    example: BookingFarePayment.PAY_LATER,
  })
  @IsOptional()
  @IsEnum(BookingFarePayment)
  farePayment?: BookingFarePayment;
}
