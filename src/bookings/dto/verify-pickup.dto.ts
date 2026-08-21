import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches, Length } from 'class-validator';

export class VerifyPickupDto {
  @ApiProperty({
    description: '4-digit pickup OTP shown to the passenger',
    example: '4821',
  })
  @IsString()
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'otp must be exactly 4 digits' })
  otp!: string;
}
