import {
  ApiBearerAuth,
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
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { AccountDeletionService } from '../users/account-deletion/account-deletion.service';
import {
  AdminAccountDeletionListQueryDto,
  AdminAccountDeletionPageDto,
  AdminApproveDeletionDto,
  AdminCompleteDeletionDto,
  AdminRequestUserActionDto,
  AdminReviewDeletionDto,
} from '../users/account-deletion/dto/admin-account-deletion.dto';
import {
  ADMIN_PERMISSION_ACCOUNT_DELETIONS_MANAGE,
  ADMIN_PERMISSION_ACCOUNT_DELETIONS_VIEW,
} from './admin.constants';
import { RequireAdminPermission } from './decorators/require-admin-permission.decorator';
import { AdminPermissionGuard } from './guards/admin-permission.guard';

@ApiTags('Admin Account Deletion')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
@ApiForbiddenResponse({ description: 'Admin permission required' })
@Controller('admin/account-deletion-requests')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
export class AdminAccountDeletionController {
  constructor(private readonly deletionService: AccountDeletionService) {}

  @Get()
  @RequireAdminPermission(ADMIN_PERMISSION_ACCOUNT_DELETIONS_VIEW)
  @ApiOperation({
    summary: 'List account deletion requests with filtering and counts',
  })
  @ApiOkResponse({ type: AdminAccountDeletionPageDto })
  list(@Query() query: AdminAccountDeletionListQueryDto) {
    return this.deletionService.adminList(query);
  }

  @Get(':id')
  @RequireAdminPermission(ADMIN_PERMISSION_ACCOUNT_DELETIONS_VIEW)
  @ApiOperation({
    summary:
      'Detailed account deletion request view with live obligations audit',
  })
  @ApiNotFoundResponse({
    description: 'ACCOUNT_DELETION_REQUEST_NOT_FOUND',
  })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.deletionService.adminGetDetail(id);
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @RequireAdminPermission(ADMIN_PERMISSION_ACCOUNT_DELETIONS_MANAGE)
  @ApiOperation({
    summary: 'Start reviewing a deletion request (PENDING -> UNDER_REVIEW)',
  })
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() body: AdminReviewDeletionDto,
  ) {
    return this.deletionService.adminReview(id, admin.userId, body?.adminNote);
  }

  @Post(':id/request-user-action')
  @HttpCode(HttpStatus.OK)
  @RequireAdminPermission(ADMIN_PERMISSION_ACCOUNT_DELETIONS_MANAGE)
  @ApiOperation({
    summary:
      'Request action from user before deletion can proceed (UNDER_REVIEW -> ACTION_REQUIRED)',
  })
  requestUserAction(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() body: AdminRequestUserActionDto,
  ) {
    return this.deletionService.adminRequestUserAction(
      id,
      admin.userId,
      body.message,
      body.adminNote,
    );
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequireAdminPermission(ADMIN_PERMISSION_ACCOUNT_DELETIONS_MANAGE)
  @ApiOperation({
    summary:
      'Approve account deletion (requires 0 outstanding obligations; does not complete yet)',
  })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() body: AdminApproveDeletionDto,
  ) {
    return this.deletionService.adminApprove(id, admin.userId, body?.adminNote);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @RequireAdminPermission(ADMIN_PERMISSION_ACCOUNT_DELETIONS_MANAGE)
  @ApiOperation({
    summary:
      'Permanently complete account deletion: anonymizes personal data, releases phone, deactivates devices, and retains ledger records',
  })
  complete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() body: AdminCompleteDeletionDto,
  ) {
    return this.deletionService.adminComplete(
      id,
      admin.userId,
      body?.adminNote,
    );
  }
}
