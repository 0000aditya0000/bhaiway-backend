import { ApiProperty } from '@nestjs/swagger';

export class WalletBucketCoinsDto {
  @ApiProperty({
    description: 'Spendable coins in this bucket (integer string, 1 Coin = ₹1)',
    example: '500',
  })
  availableCoins!: string;

  @ApiProperty({
    description: 'Held/escrowed coins in this bucket (integer string)',
    example: '100',
  })
  heldCoins!: string;
}

export class WalletBucketsDto {
  @ApiProperty({ type: WalletBucketCoinsDto })
  purchased!: WalletBucketCoinsDto;

  @ApiProperty({ type: WalletBucketCoinsDto })
  promotional!: WalletBucketCoinsDto;

  @ApiProperty({ type: WalletBucketCoinsDto })
  driverEarned!: WalletBucketCoinsDto;
}

export class WalletBalanceResponseDto {
  @ApiProperty({
    description:
      'Total wallet coins (available + held). Integer string; 1 Coin = ₹1.',
    example: '1000',
  })
  balanceCoins!: string;

  @ApiProperty({
    description: 'Spendable coins across all buckets',
    example: '800',
  })
  availableCoins!: string;

  @ApiProperty({
    description: 'Escrowed coins across all buckets',
    example: '200',
  })
  heldCoins!: string;

  @ApiProperty({
    description: 'Withdrawable coins (driver-earned available only)',
    example: '100',
  })
  withdrawableCoins!: string;

  @ApiProperty({
    description:
      'Non-withdrawable spendable coins (promotional + purchased available)',
    example: '700',
  })
  nonWithdrawableCoins!: string;

  @ApiProperty({ type: WalletBucketsDto })
  buckets!: WalletBucketsDto;
}
