import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminDashboardService } from './admin-dashboard.service';
import { ADMIN_PERMISSION_DASHBOARD_VIEW } from './admin.constants';
import { RequireAdminPermission } from './decorators/require-admin-permission.decorator';
import {
  AdminLiveMapQueryDto,
  AdminLiveMapFilter,
  AdminRecentActivityQueryDto,
} from './dto/admin-dashboard-query.dto';
import {
  AdminDashboardSummaryResponseDto,
  AdminLiveMapResponseDto,
  AdminRecentActivityResponseDto,
} from './dto/admin-dashboard-response.dto';
import { AdminPermissionGuard } from './guards/admin-permission.guard';

@ApiTags('Admin Dashboard')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
@ApiForbiddenResponse({ description: 'Admin permission required' })
@Controller('admin/dashboard')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermission(ADMIN_PERMISSION_DASHBOARD_VIEW)
export class AdminDashboardController {
  constructor(private readonly dashboardService: AdminDashboardService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Operational dashboard summary (Asia/Kolkata day metrics)',
  })
  @ApiOkResponse({ type: AdminDashboardSummaryResponseDto })
  getSummary() {
    return this.dashboardService.getSummary();
  }

  @Get('live-map')
  @ApiOperation({ summary: 'Live ride locations for the admin map' })
  @ApiOkResponse({ type: AdminLiveMapResponseDto })
  getLiveMap(@Query() query: AdminLiveMapQueryDto) {
    return this.dashboardService.getLiveMap(
      query.filter ?? AdminLiveMapFilter.ACTIVE,
    );
  }

  @Get('recent-activity')
  @ApiOperation({ summary: 'Paginated admin activity feed' })
  @ApiOkResponse({ type: AdminRecentActivityResponseDto })
  getRecentActivity(@Query() query: AdminRecentActivityQueryDto) {
    return this.dashboardService.getRecentActivity(
      query.limit ?? 20,
      query.cursor,
    );
  }
}
