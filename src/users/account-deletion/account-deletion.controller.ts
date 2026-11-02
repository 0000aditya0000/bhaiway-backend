import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AllowDeletionPending } from '../../auth/decorators/allow-deletion-pending.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { AccountDeletionService } from './account-deletion.service';
import {
  CancelAccountDeletionResponseDto,
  GetAccountDeletionStatusResponseDto,
  SubmitAccountDeletionResponseDto,
} from './dto/account-deletion-response.dto';
import { SubmitAccountDeletionDto } from './dto/submit-account-deletion.dto';

@ApiTags('Account Deletion')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({
  description: 'Missing or invalid authentication token',
})
@ApiForbiddenResponse({
  description: 'Regular operations restricted while deletion is pending',
})
@Controller('users/me/account-deletion')
@UseGuards(JwtAuthGuard)
export class AccountDeletionController {
  constructor(private readonly deletionService: AccountDeletionService) {}

  @Post('request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit an account deletion request',
    description:
      'Creates a deletion request, temporarily restricts account access, revokes existing sessions, and notifies the operations team.',
  })
  @ApiOkResponse({ type: SubmitAccountDeletionResponseDto })
  @ApiBadRequestResponse({
    description:
      'Terms not accepted, invalid reason, or account already deleted',
  })
  @ApiConflictResponse({
    description: 'An active deletion request already exists for this user',
  })
  submitRequest(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: SubmitAccountDeletionDto,
  ) {
    return this.deletionService.submitRequest(currentUser.userId, body);
  }

  @Get()
  @AllowDeletionPending()
  @ApiOperation({
    summary: 'Get current account deletion request status',
    description:
      'Accessible even when account is restricted. Shows request status, response due date, and whether user action is required.',
  })
  @ApiOkResponse({ type: GetAccountDeletionStatusResponseDto })
  getStatus(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.deletionService.getStatus(currentUser.userId);
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @AllowDeletionPending()
  @ApiOperation({
    summary: 'Cancel an active account deletion request',
    description:
      'Restores account lifecycle state to ACTIVE, re-enables full access, and preserves all user records without recreation.',
  })
  @ApiOkResponse({ type: CancelAccountDeletionResponseDto })
  @ApiConflictResponse({
    description:
      'Permanent deletion has already completed and cannot be cancelled',
  })
  @ApiNotFoundResponse({
    description: 'No active deletion request found for this account',
  })
  cancelRequest(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.deletionService.cancelRequest(currentUser.userId);
  }
}
