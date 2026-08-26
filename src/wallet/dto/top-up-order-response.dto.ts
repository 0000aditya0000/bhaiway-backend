import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  PaymentOrderProvider,
  PaymentOrderStatus,
} from '../enums/payment-order.enums';

export class MockTopUpInstructionsDto {
  @ApiProperty({ example: '/wallet/top-up/callback' })
  callbackPath!: string;

  @ApiProperty({ example: 'x-payment-signature' })
  signatureHeader!: string;

  @ApiProperty()
  note!: string;
}

export class TopUpOrderResponseDto {
  @ApiProperty({ format: 'uuid' })
  paymentOrderId!: string;

  @ApiProperty({
    description: 'Order amount in coins (integer string, 1 Coin = ₹1)',
    example: '500',
  })
  amount!: string;

  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({ enum: PaymentOrderStatus, enumName: 'PaymentOrderStatus' })
  status!: PaymentOrderStatus;

  @ApiProperty({ enum: PaymentOrderProvider, enumName: 'PaymentOrderProvider' })
  provider!: PaymentOrderProvider;

  @ApiProperty()
  gatewayOrderId!: string;

  @ApiPropertyOptional()
  paymentReference?: string;

  @ApiPropertyOptional({ type: MockTopUpInstructionsDto })
  mockInstructions?: MockTopUpInstructionsDto;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Present after verified SUCCESS callback',
  })
  walletTransactionId?: string | null;

  @ApiPropertyOptional({
    description: 'Gateway callback reference after completion',
  })
  callbackReference?: string | null;
}
