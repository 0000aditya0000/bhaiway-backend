import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ReferralStatus } from '../enums/referral.enums';

export class ReferralReferredUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Rahul' })
  name!: string | null;

  @ApiPropertyOptional({ nullable: true })
  profilePhoto!: string | null;
}

export class ReferralListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: ReferralReferredUserDto })
  referredUser!: ReferralReferredUserDto;

  @ApiProperty({ example: '50' })
  rewardCoins!: string;

  @ApiProperty({ enum: ReferralStatus, enumName: 'ReferralStatus' })
  status!: ReferralStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  rewardedAt!: string | null;
}

export class ReferralListQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  limit?: number = 20;
}

export class ReferralPageDto {
  @ApiProperty({ type: ReferralListItemDto, isArray: true })
  items!: ReferralListItemDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 5 })
  total!: number;
}

export class ReferralSummaryDto {
  @ApiProperty({ example: 'BHW7K4P9' })
  referralCode!: string;

  @ApiProperty({ example: 5 })
  totalReferrals!: number;

  @ApiProperty({
    example: '250',
    description: 'Total promotional Coins earned as a referrer (not wallet balance)',
  })
  totalCoinsEarned!: string;
}
