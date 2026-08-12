import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VerifyMsg91Dto {
  @ApiProperty({
    description: 'MSG91 Widget access-token returned after OTP verification on the client',
    example: 'MSG91_ACCESS_TOKEN',
  })
  accessToken!: string;
}
