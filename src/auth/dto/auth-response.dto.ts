import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AuthUserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+919876543210' })
  phone!: string;

  @ApiProperty({ example: true })
  phoneVerified!: boolean;

  @ApiPropertyOptional({
    description: 'Saved contact email',
    example: 'user@example.com',
    nullable: true,
  })
  email?: string | null;

  @ApiPropertyOptional({
    description: 'Email verification status',
    example: false,
  })
  emailVerified?: boolean;

  @ApiPropertyOptional({
    description: 'Profile photo Cloudinary secure_url',
    example:
      'https://res.cloudinary.com/bhaiway/image/upload/v1234/profile.jpg',
    nullable: true,
  })
  profilePhoto?: string | null;

  @ApiPropertyOptional({
    description: 'User display name or full name',
    example: 'Aditya Gangwar',
    nullable: true,
  })
  name?: string | null;

  @ApiPropertyOptional({
    description: 'User first name',
    example: 'Aditya',
    nullable: true,
  })
  firstName?: string | null;

  @ApiPropertyOptional({
    description: 'User last name',
    example: 'Gangwar',
    nullable: true,
  })
  lastName?: string | null;

  @ApiProperty({
    description: 'True when the user has completed the required profile fields',
    example: false,
  })
  profileCompleted!: boolean;

  @ApiPropertyOptional({
    description: 'User account status',
    example: 'ACTIVE',
  })
  status?: string;
}

export class AuthLoginResponseDto {
  @ApiProperty({
    description: 'BhaiWay JWT access token',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  accessToken!: string;

  @ApiProperty({ type: AuthUserResponseDto })
  user!: AuthUserResponseDto;

  @ApiPropertyOptional({
    description:
      'True when account deletion has been requested and normal access is restricted',
    example: false,
  })
  deletionPending?: boolean;
}
