import { ApiProperty } from '@nestjs/swagger';

export class RequestEmailChangeResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({
    example: 'Verification OTP sent to your new email address.',
  })
  message!: string;
}

export class VerifyEmailChangeUserDto {
  @ApiProperty({ example: 'new@example.com' })
  email!: string;

  @ApiProperty({ example: true })
  emailVerified!: boolean;
}

export class VerifyEmailChangeResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: 'Email address updated successfully.' })
  message!: string;

  @ApiProperty({ type: VerifyEmailChangeUserDto })
  user!: VerifyEmailChangeUserDto;
}
