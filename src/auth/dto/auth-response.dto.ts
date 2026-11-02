import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AuthUserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+919876543210' })
  phone!: string;

  @ApiProperty({ example: true })
  phoneVerified!: boolean;

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
