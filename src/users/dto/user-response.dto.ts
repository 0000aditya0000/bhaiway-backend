import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { WalletBalanceResponseDto } from '../../wallet/dto/wallet-balance-response.dto';
import { Gender } from '../entities/user-profile.entity';
import { UserStatus } from '../entities/user.entity';

export class UserRatingAverageDto {
  @ApiProperty({
    description: 'Average star rating (1 decimal place)',
    example: 4.5,
  })
  averageRating!: number;

  @ApiProperty({
    description: 'Number of completed ratings in this category',
    example: 12,
  })
  totalRatings!: number;
}

export class UserRatingsSummarySectionDto {
  @ApiProperty({
    type: UserRatingAverageDto,
    description: 'All ratings received by the user',
  })
  overall!: UserRatingAverageDto;

  @ApiProperty({
    type: UserRatingAverageDto,
    description: 'Ratings received when acting as a driver',
  })
  asDriver!: UserRatingAverageDto;

  @ApiProperty({
    type: UserRatingAverageDto,
    description: 'Ratings received when acting as a passenger/rider',
  })
  asRider!: UserRatingAverageDto;
}

export class UserDriverEarningsDto {
  @ApiProperty({
    description: 'Lifetime driver earnings from Regular rides (coins)',
    example: '1500',
  })
  regularTotalCoins!: string;

  @ApiProperty({
    description: 'Lifetime driver earnings from Assured rides (coins)',
    example: '800',
  })
  assuredTotalCoins!: string;

  @ApiProperty({
    description: 'Lifetime driver earnings from Office Commute rides (coins)',
    example: '400',
  })
  commuteTotalCoins!: string;

  @ApiProperty({
    description: 'Total lifetime driver earnings across all ride types (coins)',
    example: '2700',
  })
  totalCoins!: string;
}

export class UserSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+919876543210' })
  phone!: string;

  @ApiProperty({ example: true })
  phoneVerified!: boolean;

  @ApiPropertyOptional({ nullable: true, example: null })
  email!: string | null;

  @ApiProperty({ example: false })
  emailVerified!: boolean;

  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus', example: UserStatus.ACTIVE })
  status!: UserStatus;
}

export class ProfileResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Aditya' })
  firstName!: string;

  @ApiPropertyOptional({ nullable: true })
  lastName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  displayName!: string | null;

  @ApiPropertyOptional({ enum: Gender, enumName: 'Gender', nullable: true })
  gender!: Gender | null;

  @ApiPropertyOptional({ nullable: true, example: '2000-01-01' })
  dateOfBirth!: string | null;

  @ApiPropertyOptional({ nullable: true })
  profilePhoto!: string | null;
}

export class GetMeResponseDto {
  @ApiProperty({ type: UserSummaryDto })
  user!: UserSummaryDto;

  @ApiPropertyOptional({
    type: ProfileResponseDto,
    nullable: true,
    description: 'Null when the user has not created a profile yet',
  })
  profile!: ProfileResponseDto | null;

  @ApiProperty({
    description: 'True when required profile information is present',
    example: false,
  })
  profileCompleted!: boolean;

  @ApiPropertyOptional({
    description:
      'Active Assured deposit penalty for the passenger (elevated rate after self-cancel)',
    nullable: true,
    example: {
      percentage: 10,
      reason: 'PREVIOUS_ASSURED_CANCELLATION',
    },
  })
  assuredDepositPenalty?: {
    percentage: number;
    reason: string;
  } | null;

  @ApiProperty({
    type: WalletBalanceResponseDto,
    description: 'Current wallet coin balance and bucket breakdown',
  })
  wallet!: WalletBalanceResponseDto;

  @ApiProperty({
    type: UserDriverEarningsDto,
    description:
      'Lifetime driver earnings split by ride type (Regular, Assured, Office Commute)',
  })
  driverEarnings!: UserDriverEarningsDto;

  @ApiProperty({
    type: UserRatingsSummarySectionDto,
    description:
      'Rating averages from received ratings, split by driver and rider roles',
  })
  ratings!: UserRatingsSummarySectionDto;
}
