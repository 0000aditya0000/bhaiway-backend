import {
  Body,
  Controller,
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
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import {
  ADMIN_PERMISSION_RIDES_MANAGE,
  ADMIN_PERMISSION_RIDES_VIEW,
} from '../admin.constants';
import { RequireAdminPermission } from '../decorators/require-admin-permission.decorator';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { AdminRideCancellationService } from './admin-ride-cancellation.service';
import { AdminRidesService } from './admin-rides.service';
import {
  AdminCancelRideDto,
  AdminCancelRideResponseDto,
} from './dto/admin-ride-cancel.dto';
import {
  AdminRideListQueryDto,
  AdminRideListResponseDto,
} from './dto/admin-ride-list.dto';

@ApiTags('Admin Rides')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
@ApiForbiddenResponse({ description: 'Admin permission required' })
@Controller('admin/rides')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
export class AdminRidesController {
  constructor(
    private readonly ridesService: AdminRidesService,
    private readonly cancellationService: AdminRideCancellationService,
  ) {}

  @Get()
  @RequireAdminPermission(ADMIN_PERMISSION_RIDES_VIEW)
  @ApiOperation({
    summary: 'Admin rides directory',
    description:
      'Search by ride UUID, driver/passenger UUID, name, or phone. Filter by status, type, dates, source, and destination. Phone numbers are masked.',
  })
  @ApiOkResponse({ type: AdminRideListResponseDto })
  list(@Query() query: AdminRideListQueryDto) {
    return this.ridesService.list(query);
  }

  @Get(':rideId')
  @RequireAdminPermission(ADMIN_PERMISSION_RIDES_VIEW)
  @ApiOperation({
    summary: 'Complete admin ride operational detail',
    description:
      'Full PII, bookings, wallet ledger, deposits, latest GPS, and cancellation history for authorized admins.',
  })
  @ApiNotFoundResponse({ description: 'ADMIN_RIDE_NOT_FOUND' })
  getOne(@Param('rideId', ParseUUIDPipe) rideId: string) {
    return this.ridesService.getDetail(rideId);
  }

  @Post(':rideId/cancel')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_RIDES_MANAGE)
  @ApiOperation({
    summary: 'Cancel a ride as BhaiWay operations',
    description:
      'Bypasses driver/passenger ownership rules for eligible rides. COMPLETED returns 409. Already CANCELLED is idempotent. IN_PROGRESS issues no automatic refund or compensation.',
  })
  @ApiOkResponse({ type: AdminCancelRideResponseDto })
  @ApiConflictResponse({ description: 'RIDE_ALREADY_COMPLETED' })
  @ApiNotFoundResponse({ description: 'ADMIN_RIDE_NOT_FOUND' })
  cancel(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body() body: AdminCancelRideDto,
  ) {
    return this.cancellationService.cancel(admin.userId, rideId, body);
  }
}
