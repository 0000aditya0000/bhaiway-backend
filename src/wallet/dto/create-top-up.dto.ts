import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class CreateTopUpDto {
  @ApiProperty({
    description:
      'Top-up amount in BhaiWay Coins as a positive integer string (1 Coin = ₹1)',
    example: '500',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[1-9]\d*$/, {
    message: 'amount must be a positive integer string without decimals',
  })
  amount!: string;
}
