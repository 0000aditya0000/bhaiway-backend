import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { VerificationStatus } from '../enums/verification.enums';

export class VerificationStatusViewDto {
  @ApiProperty({
    enum: VerificationStatus,
    enumName: 'VerificationStatus',
    example: VerificationStatus.PENDING,
  })
  status!: VerificationStatus;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  submittedAt!: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  verifiedAt!: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  rejectedAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  rejectionReason!: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  expiresAt!: string | null;
}

export class MyVerificationsResponseDto {
  @ApiProperty({ type: VerificationStatusViewDto })
  identity!: VerificationStatusViewDto;

  @ApiProperty({ type: VerificationStatusViewDto })
  drivingLicense!: VerificationStatusViewDto;

  @ApiProperty({ type: VerificationStatusViewDto })
  vehicle!: VerificationStatusViewDto;
}
