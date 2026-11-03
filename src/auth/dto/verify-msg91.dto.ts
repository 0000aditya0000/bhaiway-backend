import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import { IsCloudinaryUrl } from '../../users/validators/is-cloudinary-url.validator';

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
 * Optional email is saved to the account on registration/login if not already set.
 * Optional mode ("register") or isRegistration (true) rejects duplicate active accounts with 409 PHONE_ALREADY_REGISTERED.
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
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : (value as string),
  )
  referralCode?: string;

  @ApiPropertyOptional({
    description:
      'Optional contact email submitted during registration. Normalized to lowercase. Not treated as verified.',
    example: 'user@example.com',
    maxLength: 255,
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : (value as string),
  )
  email?: string;

  @ApiPropertyOptional({
    description:
      'Auth mode. Set to "register" or "REGISTRATION" to reject existing active accounts with 409 PHONE_ALREADY_REGISTERED.',
    example: 'register',
  })
  @IsOptional()
  @IsString()
  mode?: string;

  @ApiPropertyOptional({
    description:
      'Flag indicating registration intent. If true and phone belongs to an active account, returns 409 PHONE_ALREADY_REGISTERED.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isRegistration?: boolean;

  @ApiPropertyOptional({
    description:
      'Profile photo Cloudinary secure_url submitted during registration',
    example:
      'https://res.cloudinary.com/bhaiway/image/upload/v1234/profile.jpg',
  })
  @IsOptional()
  @IsString()
  @IsCloudinaryUrl()
  profilePhoto?: string;

  @ApiPropertyOptional({
    description: 'Full name submitted during registration',
    example: 'Aditya Gangwar',
    maxLength: 150,
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({
    description: 'First name submitted during registration',
    example: 'Aditya',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({
    description: 'Last name submitted during registration',
    example: 'Gangwar',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;
}
