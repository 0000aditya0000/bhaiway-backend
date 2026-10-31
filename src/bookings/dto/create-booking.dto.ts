import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { CouponChargeScope } from '../../coupons/enums/coupon.enums';
import {
  BookingFarePayment,
  BookingPaymentMethod,
  BookingPaymentMethodAlias,
  canonicalizeBookingPaymentMethod,
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
    enum: [
      ...Object.values(BookingPaymentMethod),
      ...Object.values(BookingPaymentMethodAlias),
    ],
    example: BookingPaymentMethodAlias.WALLET,
    description:
      'REGULAR: WALLET (alias PAY_NOW) debits BhaiWay Wallet at booking; PAY_AFTER_RIDE (alias PAY_LATER) defers fare until after the trip. ' +
      'COMMUTE: always charged upfront (send PAY_NOW or WALLET; paymentMethod is ignored except ASSURED_DEPOSIT is rejected). ' +
      'ASSURED deposit booking: ASSURED_DEPOSIT (mandatory). After ALLOW_REGULAR_RIDERS, remaining Assured seats may use WALLET/PAY_NOW or PAY_AFTER_RIDE/PAY_LATER without deposit. ' +
      'WALLET and PAY_AFTER_RIDE are request aliases only; stored paymentMethod is PAY_NOW or PAY_LATER.',
  })
  @Transform(({ value }) => canonicalizeBookingPaymentMethod(value))
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

  @ApiPropertyOptional({
    description:
      'Catalog coupon code. Applied server-side to the charge selected by couponChargeScope (or inferred). Never trust client discount amounts.',
    example: 'SAVE50',
  })
  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  couponCode?: string;

  @ApiPropertyOptional({
    enum: CouponChargeScope,
    enumName: 'CouponChargeScope',
    description:
      'Which charge the coupon applies to. For Assured deposit bookings defaults to ASSURED_SECURITY_DEPOSIT; for PAY_NOW/COMMUTE fare defaults to RIDE_FARE. BOTH is not accepted at apply-time — pick one charge.',
  })
  @IsOptional()
  @IsEnum(CouponChargeScope)
  couponChargeScope?: CouponChargeScope;
}