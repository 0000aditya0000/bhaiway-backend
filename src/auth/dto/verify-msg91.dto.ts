import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * MSG91 Widget verify payload.
 *
 * Normal production path (unchanged):
 *   { "accessToken": "<MSG91 widget access-token>" }
 *
 * Play Store review path (only when PLAY_REVIEW_LOGIN_ENABLED=true):
 *   { "phone": "<configured review phone>", "otp": "<configured review OTP>" }
 *
 * Optional referralCode is applied only when the backend creates a NEW user.
 *
 * Phone/OTP credentials are never hard-coded in source; they come from env.
 */
export class VerifyMsg91Dto {
  @ApiPropertyOptional({
    description:
      'MSG91 Widget access-token returned after OTP verification on the client. Required for normal login.',
    example: 'MSG91_ACCESS_TOKEN',
  })
  @ValidateIf((o: VerifyMsg91Dto) => !o.phone && !o.otp)
  @IsString()
  @IsOptional()
  accessToken?: string;

  @ApiPropertyOptional({
    description:
      'Phone number for Play Store review login only. Ignored unless PLAY_REVIEW_LOGIN_ENABLED=true and OTP is also provided.',
    example: '9761454075',
  })
  @ValidateIf((o: VerifyMsg91Dto) => !o.accessToken)
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({
    description:
      'OTP for Play Store review login only. Ignored unless PLAY_REVIEW_LOGIN_ENABLED=true and phone is also provided.',
    example: '1234',
  })
  @ValidateIf((o: VerifyMsg91Dto) => !o.accessToken)
  @IsString()
  @IsOptional()
  otp?: string;

  @ApiPropertyOptional({
    description:
      'Optional referral code for NEW users only. Trimmed and uppercased. Ignored for existing accounts.',
    example: 'BHW7K4P9',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  referralCode?: string;
}
