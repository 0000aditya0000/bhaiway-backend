import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength } from 'class-validator';

export class VerifyCorporateIdentityDto {
  @ApiProperty({
    example: 'employee@company.com',
    description: 'Official corporate email address being verified',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({ example: '4827', description: '4-digit verification code' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^\d{4}$/, { message: 'otp must be a 4-digit numeric code' })
  otp!: string;
}
