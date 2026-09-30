import { ApiProperty } from '@nestjs/swagger';

export class AdminLoginResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty({
    description: 'Admin account summary (no password/hash fields)',
  })
  admin!: {
    id: string;
    username: string;
    permissions: string[];
  };
}
