import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AccountDeletionRequestStatus,
  DeletionReason,
} from '../enums/account-deletion.enums';

export class AccountDeletionRequestSummaryDto {
  @ApiProperty({ description: 'Unique deletion request identifier' })
  id!: string;

  @ApiProperty({
    enum: AccountDeletionRequestStatus,
    description: 'Current status of the deletion request',
  })
  status!: AccountDeletionRequestStatus;

  @ApiProperty({
    enum: DeletionReason,
    description: 'Selected deletion reason',
  })
  reason!: DeletionReason;

  @ApiProperty({ description: 'Timestamp when request was submitted' })
  requestedAt!: Date;

  @ApiProperty({
    description: 'Expected response due date (7 Indian business days)',
  })
  responseDueAt!: Date;

  @ApiProperty({
    description: 'Whether admin requires additional action from the user',
  })
  userActionRequired!: boolean;

  @ApiPropertyOptional({
    description: 'User-facing explanation of what action is required',
    nullable: true,
  })
  userActionMessage!: string | null;

  @ApiProperty({
    description: 'Whether the user is currently allowed to cancel the request',
  })
  canCancel!: boolean;

  @ApiProperty({
    description: 'Whether permanent deletion has been completed',
  })
  isCompleted!: boolean;
}

export class SubmitAccountDeletionResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ description: 'Deletion request information' })
  request!: {
    id: string;
    status: AccountDeletionRequestStatus;
    requestedAt: Date;
    responseDueAt: Date;
  };

  @ApiProperty({
    example: 'Your account deletion request has been received.',
  })
  message!: string;
}

export class GetAccountDeletionStatusResponseDto {
  @ApiProperty({
    description: 'Whether there is an active deletion request for this account',
  })
  hasActiveRequest!: boolean;

  @ApiPropertyOptional({
    description: 'Current deletion request information, if one exists',
    type: AccountDeletionRequestSummaryDto,
    nullable: true,
  })
  request!: AccountDeletionRequestSummaryDto | null;
}

export class CancelAccountDeletionResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({
    example:
      'Your account deletion request has been cancelled and full account access has been restored.',
  })
  message!: string;
}
