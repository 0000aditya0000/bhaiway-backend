import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class VerifyTopUpDto {
  @ApiProperty({
    description: 'Razorpay order ID (order_...)',
    example: 'order_EKfLvuAfaoKU8z',
  })
  @IsString()
  @IsNotEmpty()
  razorpay_order_id!: string;

  @ApiProperty({
    description: 'Razorpay payment ID (pay_...)',
    example: 'pay_29Ae07wjhvd10x',
  })
  @IsString()
  @IsNotEmpty()
  razorpay_payment_id!: string;

  @ApiProperty({
    description: 'Razorpay HMAC-SHA256 signature of order_id|payment_id',
    example: '9ef57201407e335cf9e1d1b32d56a2aa777d1300edc64ddba2b3b0d711c21051',
  })
  @IsString()
  @IsNotEmpty()
  razorpay_signature!: string;
}
