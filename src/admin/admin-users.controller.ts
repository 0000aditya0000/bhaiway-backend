import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { AdminUsersService } from './admin-users.service';
import {
  ADMIN_PERMISSION_USERS_MANAGE,
  ADMIN_PERMISSION_USERS_VIEW,
} from './admin.constants';
import { RequireAdminPermission } from './decorators/require-admin-permission.decorator';
import {
  AdminRestrictionReasonDto,
  AdminSuspendUserDto,
  AdminUserListQueryDto,
  AdminUserPageDto,
} from './dto/admin-user.dto';
import { AdminPermissionGuard } from './guards/admin-permission.guard';

@ApiTags('Admin Users')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
@ApiForbiddenResponse({ description: 'Admin permission required' })
@Controller('admin/users')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
export class AdminUsersController {
  constructor(private readonly usersService: AdminUsersService) {}

  @Get()
  @RequireAdminPermission(ADMIN_PERMISSION_USERS_VIEW)
  @ApiOperation({
    summary: 'Paginated users directory',
    description:
      'Search by name/id/phone/email. userType RIDER/DRIVER/BOTH uses real booking/vehicle/verification signals. Summary driver/rider counts may overlap.',
  })
  @ApiOkResponse({ type: AdminUserPageDto })
  list(@Query() query: AdminUserListQueryDto) {
    return this.usersService.list(query);
  }

  @Get(':userId')
  @RequireAdminPermission(ADMIN_PERMISSION_USERS_VIEW)
  @ApiOperation({ summary: 'User detail for admin support' })
  @ApiNotFoundResponse({ description: 'ADMIN_USER_NOT_FOUND' })
  getOne(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.usersService.getDetail(userId);
  }

  @Post(':userId/suspend')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_USERS_MANAGE)
  @ApiOperation({
    summary: 'Suspend a user',
    description:
      'Sets status=SUSPENDED, increments token_version (immediate JWT rejection), records audit. Does not delete data.',
  })
  suspend(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: AdminSuspendUserDto,
  ) {
    return this.usersService.suspend(admin.userId, userId, body);
  }

  @Post(':userId/unsuspend')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_USERS_MANAGE)
  @ApiOperation({
    summary: 'Unsuspend a user',
    description:
      'Restores ACTIVE status and bumps token_version so pre-suspension tokens stay invalid. Does not recreate sessions.',
  })
  unsuspend(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.usersService.unsuspend(admin.userId, userId);
  }

  @Post(':userId/restrictions/booking')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_USERS_MANAGE)
  @ApiOperation({ summary: 'Restrict the user from creating new bookings' })
  restrictBooking(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: AdminRestrictionReasonDto,
  ) {
    return this.usersService.restrictBooking(admin.userId, userId, body);
  }

  @Delete(':userId/restrictions/booking')
  @RequireAdminPermission(ADMIN_PERMISSION_USERS_MANAGE)
  @ApiOperation({ summary: 'Clear booking restriction' })
  clearBooking(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.usersService.clearBookingRestriction(admin.userId, userId);
  }

  @Post(':userId/restrictions/ride-publishing')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_USERS_MANAGE)
  @ApiOperation({
    summary: 'Restrict the user from publishing new rides',
    description: 'Applies to regular, assured, and commute publish flows.',
  })
  restrictPublish(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: AdminRestrictionReasonDto,
  ) {
    return this.usersService.restrictRidePublishing(admin.userId, userId, body);
  }

  @Delete(':userId/restrictions/ride-publishing')
  @RequireAdminPermission(ADMIN_PERMISSION_USERS_MANAGE)
  @ApiOperation({ summary: 'Clear ride-publishing restriction' })
  clearPublish(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.usersService.clearRidePublishingRestriction(
      admin.userId,
      userId,
    );
  }
}
