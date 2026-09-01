import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { BookingPaymentStatus } from '../enums/booking.enums';

export class PayLaterPaymentResponseDto {
  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({
    description: 'Total fare in integer points (1 point = ₹1)',
    example: '400',
  })
  fareAmount!: string;

  @ApiProperty({ enum: BookingPaymentStatus, enumName: 'BookingPaymentStatus' })
  paymentStatus!: BookingPaymentStatus;

  @ApiProperty({
    description: 'Passenger wallet debited (wallet payment only)',
    example: '400',
  })
  passengerDebited!: string;

  @ApiProperty({
    description: 'Driver wallet credited (wallet payment only)',
    example: '400',
  })
  driverCredited!: string;

  @ApiProperty({ enum: ['WALLET', 'CASH'] })
  paymentChannel!: 'WALLET' | 'CASH';

  @ApiProperty({
    description: 'True when the fare was already settled (idempotent retry)',
  })
  alreadySettled!: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Wallet ledger transaction id (wallet payment only)',
  })
  transactionId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'ISO timestamp when fare was marked paid',
  })
  paidAt?: string | null;
}

/** @deprecated Use PayLaterPaymentResponseDto */
export type RegularPayLaterPaymentResponseDto = PayLaterPaymentResponseDto;
