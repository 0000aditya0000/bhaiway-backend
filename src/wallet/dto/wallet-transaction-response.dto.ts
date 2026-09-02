import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { RideType } from '../../rides/enums/ride.enums';
import { WalletPointSource } from '../entities/wallet-point-lot.entity';
import {
  WalletTransactionDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from '../entities/wallet-transaction.entity';
import { WalletTransactionDisplayCategory } from '../wallet-transaction-display.mapper';

export class WalletTransactionItemDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Immutable ledger transaction ID',
  })
  transactionId!: string;

  @ApiProperty({ enum: WalletTransactionType, enumName: 'WalletTransactionType' })
  transactionType!: WalletTransactionType;

  @ApiProperty({ enum: WalletTransactionDirection, enumName: 'WalletTransactionDirection' })
  direction!: WalletTransactionDirection;

  @ApiProperty({
    description: 'Transaction amount in coins (integer string, 1 Coin = ₹1)',
    example: '250',
  })
  amount!: string;

  @ApiProperty({
    description: 'Wallet total balance before this transaction (coins)',
    example: '500',
  })
  balanceBefore!: string;

  @ApiProperty({
    description: 'Wallet total balance after this transaction (coins)',
    example: '750',
  })
  balanceAfter!: string;

  @ApiPropertyOptional({
    enum: WalletPointSource,
    enumName: 'WalletPointSource',
    nullable: true,
    description: 'Source bucket for credits; null for debits',
  })
  pointSource!: WalletPointSource | null;

  @ApiProperty({ enum: WalletTransactionStatus, enumName: 'WalletTransactionStatus' })
  status!: WalletTransactionStatus;

  @ApiProperty({
    description:
      'User-facing title for the mobile wallet history list (e.g. "Office commute booked", "Ride earnings")',
    example: 'Coins purchased',
  })
  displayTitle!: string;

  @ApiProperty({
    enum: WalletTransactionDisplayCategory,
    enumName: 'WalletTransactionDisplayCategory',
    description:
      'Semantic category for icons/colors in the app (TOP_UP, BOOKING, EARNING, REFUND, etc.)',
    example: WalletTransactionDisplayCategory.TOP_UP,
  })
  displayCategory!: WalletTransactionDisplayCategory;

  @ApiPropertyOptional({ nullable: true, maxLength: 50 })
  referenceType!: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 255 })
  referenceId!: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Ride UUID for booking wallet rows when resolvable from reference data. Omitted when unknown.',
  })
  rideId?: string;

  @ApiPropertyOptional({
    enum: RideType,
    enumName: 'RideType',
    description:
      'ASSURED or REGULAR for booking wallet rows when resolvable. Omitted when unknown.',
  })
  rideType?: RideType;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class WalletTransactionPageDto {
  @ApiProperty({ type: WalletTransactionItemDto, isArray: true })
  items!: WalletTransactionItemDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}
