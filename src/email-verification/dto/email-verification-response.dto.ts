import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class EmailVerificationActionResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: 'Verification code sent to your email.' })
  message!: string;
}

export class EmailVerificationStatusResponseDto {
  @ApiPropertyOptional({ nullable: true, example: 'user@example.com' })
  email!: string | null;

  @ApiProperty({ example: false })
  verified!: boolean;
}
