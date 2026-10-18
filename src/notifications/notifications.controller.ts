import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  MarkAllNotificationsReadDto,
  NotificationItemDto,
  NotificationListQueryDto,
  NotificationPageDto,
  NotificationUnreadCountDto,
} from './dto/notification-inbox.dto';
import {
  NotificationDeviceResponseDto,
  RegisterNotificationDeviceDto,
} from './dto/register-device.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  // ---------------------------------------------------------------------------
  // In-app notification center
  // ---------------------------------------------------------------------------

  @Get()
  @ApiOperation({
    summary: 'List in-app notifications for the authenticated user',
    description:
      'Newest first. Recipient is always the JWT subject — never a client-supplied user id.',
  })
  @ApiOkResponse({ type: NotificationPageDto })
  list(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: NotificationListQueryDto,
  ) {
    return this.notificationsService.listForUser(currentUser.userId, query);
  }

  @Get('unread-count')
  @ApiOperation({
    summary: 'Unread notification count for the authenticated user',
  })
  @ApiOkResponse({ type: NotificationUnreadCountDto })
  unreadCount(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.notificationsService.unreadCountForUser(currentUser.userId);
  }

  @Patch('read-all')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mark all unread notifications as read for the authenticated user',
  })
  @ApiOkResponse({ type: MarkAllNotificationsReadDto })
  markAllRead(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.notificationsService.markAllAsReadForUser(currentUser.userId);
  }

  @Patch(':id/read')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mark one notification as read (idempotent)',
    description:
      'Returns 404 for unknown ids or notifications owned by another user.',
  })
  @ApiOkResponse({ type: NotificationItemDto })
  @ApiNotFoundResponse({ description: 'NOTIFICATION_NOT_FOUND' })
  markOneRead(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.markAsReadForUser(currentUser.userId, id);
  }

  // ---------------------------------------------------------------------------
  // Device token APIs
  // ---------------------------------------------------------------------------

  @Post('devices')
  @ApiOperation({
    summary: 'Register or refresh an FCM device token',
    description:
      'JWT subject becomes the device owner. Re-registering the same token ' +
      'updates metadata and reassigns ownership if needed.',
  })
  @ApiOkResponse({ type: NotificationDeviceResponseDto })
  registerDevice(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: RegisterNotificationDeviceDto,
  ) {
    return this.notificationsService.registerDevice(currentUser.userId, body);
  }

  @Delete('devices/:token')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Deactivate the authenticated user device token',
    description:
      'Soft-deactivates is_active=false. Pass the raw FCM token (URL-encoded).',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean', example: true } },
    },
  })
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  deactivateDevice(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('token') token: string,
  ) {
    return this.notificationsService.deactivateDevice(
      currentUser.userId,
      token,
    );
  }
}
