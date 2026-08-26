import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

import { PaymentGatewayStatus } from '../payment/payment-gateway.types';

export class TopUpCallbackDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  gatewayOrderId!: string;

  @ApiProperty({
    description: 'Payment amount as integer string (1 Coin = ₹1)',
    example: '500',
  })
  @IsString()
  @Matches(/^[1-9]\d*$/, {
    message: 'amount must be a positive integer string',
  })
  amount!: string;

  @ApiProperty({ example: 'INR' })
  @IsString()
  @IsNotEmpty()
  currency!: string;

  @ApiProperty({ enum: PaymentGatewayStatus, enumName: 'PaymentGatewayStatus' })
  @IsEnum(PaymentGatewayStatus)
  status!: PaymentGatewayStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reference?: string;
}
