import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Equals,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { DeletionReason } from '../enums/account-deletion.enums';

export class SubmitAccountDeletionDto {
  @ApiProperty({
    enum: DeletionReason,
    description: 'Primary reason for requesting account deletion',
    example: DeletionReason.NO_LONGER_USING,
  })
  @IsEnum(DeletionReason, {
    message:
      'Reason must be one of: NO_LONGER_USING, PRIVACY_CONCERNS, POOR_USER_EXPERIENCE, SWITCHED_TO_ANOTHER_SERVICE, ACCOUNT_OR_TECHNICAL_ISSUES, OTHER',
  })
  reason!: DeletionReason;

  @ApiPropertyOptional({
    description: 'Optional additional comments or feedback',
    example: 'I no longer commute on this route.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000, {
    message: 'Additional comment must not exceed 1000 characters',
  })
  additionalComment?: string;

  @ApiProperty({
    description: 'User must explicitly accept the account deletion terms',
    example: true,
  })
  @IsBoolean()
  @Equals(true, {
    message: 'You must review and accept the deletion terms to proceed',
  })
  acceptedDeletionTerms!: boolean;
}
