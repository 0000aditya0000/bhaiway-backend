import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

export class VerifyEmailVerificationDto {
  @ApiProperty({ example: '4827', description: '4-digit verification code' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^\d{4}$/, { message: 'otp must be a 4-digit numeric code' })
  otp!: string;
}
