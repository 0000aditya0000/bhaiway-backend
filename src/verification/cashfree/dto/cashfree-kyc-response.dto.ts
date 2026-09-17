import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IdentityMobileStatus } from '../../enums/identity-verification.enums';
import { Gender } from '../../../users/entities/user-profile.entity';

export class CashfreeStartVerificationResponseDto {
  @ApiProperty({ description: 'Internal unique verification ID' })
  verificationId!: string;

  @ApiPropertyOptional({ description: 'Cashfree reference ID' })
  referenceId?: string | null;

  @ApiProperty({ description: 'Current verification status', example: 'PENDING' })
  status!: string;

  @ApiProperty({ description: 'Cashfree DigiLocker URL' })
  url!: string;

  @ApiPropertyOptional({ description: 'URL expiration ISO timestamp' })
  expiresAt?: string | null;
}

export class CashfreeKycStatusResponseDto {
  @ApiProperty({
    enum: IdentityMobileStatus,
    enumName: 'IdentityMobileStatus',
    description: 'High-level mobile-friendly verification status',
  })
  status!: IdentityMobileStatus;

  @ApiPropertyOptional({ description: 'Active or latest verification ID' })
  verificationId?: string | null;

  @ApiPropertyOptional({ description: 'Verified full name from Aadhaar' })
  verifiedName?: string | null;

  @ApiPropertyOptional({
    enum: Gender,
    enumName: 'Gender',
    description: 'Verified mapped gender from Aadhaar',
  })
  verifiedGender?: Gender | null;

  @ApiPropertyOptional({ description: 'Verification completion ISO timestamp' })
  verifiedAt?: string | null;
}
