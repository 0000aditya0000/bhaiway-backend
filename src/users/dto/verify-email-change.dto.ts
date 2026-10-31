import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength } from 'class-validator';

export class VerifyEmailChangeDto {
  @ApiProperty({
    example: 'new@example.com',
    description:
      'New email address to associate with the authenticated user account',
  })
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(255)
  newEmail!: string;

  @ApiProperty({
    example: '1234',
    description: 'Verification code sent to the new email address',
  })
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'otp must be a numeric code' })
  otp!: string;
}
