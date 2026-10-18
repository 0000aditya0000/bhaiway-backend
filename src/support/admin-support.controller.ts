import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { ADMIN_PERMISSION_SUPPORT_MANAGE } from '../admin/admin.constants';
import { RequireAdminPermission } from '../admin/decorators/require-admin-permission.decorator';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { AddSupportCommentDto } from './dto/add-support-comment.dto';
import { AdminSupportTicketListQueryDto } from './dto/admin-support-ticket-query.dto';
import {
  AdminSupportTicketListItemDto,
  SupportCommentDto,
  SupportTicketDetailDto,
} from './dto/support-ticket-response.dto';
import { UpdateSupportTicketStatusDto } from './dto/update-support-ticket-status.dto';
import { SupportService } from './support.service';

class AdminSupportTicketPageDto {
  items!: AdminSupportTicketListItemDto[];
  page!: number;
  limit!: number;
  total!: number;
  totalPages!: number;
}

@ApiTags('Admin Support')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
@ApiForbiddenResponse({ description: 'ADMIN_SUPPORT_MANAGE required' })
@Controller('admin/support')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermission(ADMIN_PERMISSION_SUPPORT_MANAGE)
export class AdminSupportController {
  constructor(private readonly supportService: SupportService) {}

  @Get('tickets')
  @ApiOperation({ summary: 'List support tickets (paginated, filterable)' })
  @ApiOkResponse({ type: AdminSupportTicketPageDto })
  list(@Query() query: AdminSupportTicketListQueryDto) {
    return this.supportService.listTicketsForAdmin(query);
  }

  @Get('tickets/:ticketId')
  @ApiOperation({ summary: 'Support ticket detail for admins' })
  @ApiOkResponse({ type: SupportTicketDetailDto })
  @ApiNotFoundResponse({ description: 'SUPPORT_TICKET_NOT_FOUND' })
  getOne(@Param('ticketId', ParseUUIDPipe) ticketId: string) {
    return this.supportService.getTicketForAdmin(ticketId);
  }

  @Patch('tickets/:ticketId/status')
  @ApiOperation({
    summary: 'Update support ticket status',
    description:
      'Transitions: CREATED→IN_PROGRESS|RESOLVED, IN_PROGRESS→RESOLVED. Reopening RESOLVED is not supported. Idempotent when status is unchanged.',
  })
  @ApiOkResponse({ type: SupportTicketDetailDto })
  @ApiUnprocessableEntityResponse({
    description: 'SUPPORT_STATUS_TRANSITION_INVALID',
  })
  updateStatus(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() body: UpdateSupportTicketStatusDto,
  ) {
    return this.supportService.updateStatus(admin.userId, ticketId, body);
  }

  @Post('tickets/:ticketId/comments')
  @ApiOperation({
    summary: 'Add a user-visible admin comment on a support ticket',
  })
  @ApiCreatedResponse({ type: SupportCommentDto })
  @ApiNotFoundResponse({ description: 'SUPPORT_TICKET_NOT_FOUND' })
  addComment(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() body: AddSupportCommentDto,
  ) {
    return this.supportService.addAdminComment(admin.userId, ticketId, body);
  }
}
