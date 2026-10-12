import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { CorporateIdentityStatus } from '../enums/corporate-identity-status.enum';

export class CorporateIdentityStatusResponseDto {
  @ApiProperty({
    enum: CorporateIdentityStatus,
    enumName: 'CorporateIdentityStatus',
    example: CorporateIdentityStatus.NOT_VERIFIED,
  })
  status!: CorporateIdentityStatus;

  @ApiPropertyOptional({
    nullable: true,
    example: 'employee@company.com',
  })
  email!: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  verifiedAt!: string | null;
}

export class CorporateIdentitySendResponseDto {
  @ApiProperty({
    enum: CorporateIdentityStatus,
    enumName: 'CorporateIdentityStatus',
  })
  status!: CorporateIdentityStatus;

  @ApiPropertyOptional({ nullable: true })
  email!: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  verifiedAt!: string | null;

  @ApiPropertyOptional({
    description: 'Present when a new OTP was sent',
    example: 'Corporate identity verification code sent.',
  })
  message?: string;
}
