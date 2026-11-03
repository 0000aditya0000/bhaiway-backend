import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SendMsg91OtpDto {
  @ApiProperty({
    description:
      'Phone number for OTP send. For the configured Play Store review phone (when enabled), returns success without sending SMS. All other phones use the MSG91 Widget on the client.',
    example: '9761454075',
  })
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @ApiPropertyOptional({
    description:
      'Optional flow mode. Set to "register" or "REGISTRATION" when initiating sign-up. If phone belongs to an active account, returns 409 PHONE_ALREADY_REGISTERED.',
    example: 'register',
  })
  @IsOptional()
  @IsString()
  mode?: string;

  @ApiPropertyOptional({
    description:
      'Optional flag indicating registration intent. If true and phone belongs to an active account, returns 409 PHONE_ALREADY_REGISTERED.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isRegistration?: boolean;
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
