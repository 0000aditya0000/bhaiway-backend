import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  NotificationDeviceResponseDto,
  RegisterNotificationDeviceDto,
} from './dto/register-device.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

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
