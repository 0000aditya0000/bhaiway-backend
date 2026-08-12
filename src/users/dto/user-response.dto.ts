import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Gender } from '../entities/user-profile.entity';
import { UserStatus } from '../entities/user.entity';

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
}
