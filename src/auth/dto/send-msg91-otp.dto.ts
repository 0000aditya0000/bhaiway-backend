import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class SendMsg91OtpDto {
  @ApiProperty({
    description:
      'Phone number for OTP send. For the configured Play Store review phone (when enabled), returns success without sending SMS. All other phones use the MSG91 Widget on the client.',
    example: '9761454075',
  })
  @IsString()
  @IsNotEmpty()
  phone!: string;
}

export class SendMsg91OtpResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({
    example: 'OTP sent',
    description: 'Generic status message. Never includes the OTP value.',
  })
  message!: string;
}
