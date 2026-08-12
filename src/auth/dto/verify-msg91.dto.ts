import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class VerifyMsg91Dto {
  @ApiProperty({
    description:
      'MSG91 Widget access-token returned after OTP verification on the client',
    example: 'MSG91_ACCESS_TOKEN',
  })
  @IsString()
  @IsNotEmpty()
  accessToken!: string;
}
