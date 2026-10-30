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
  ApiForbiddenResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import {
  ADMIN_PERMISSION_INCIDENTS_MANAGE,
  ADMIN_PERMISSION_INCIDENTS_VIEW,
  ADMIN_PERMISSION_SOS_MANAGE,
  ADMIN_PERMISSION_SOS_VIEW,
} from '../../admin/admin.constants';
import { RequireAdminPermission } from '../../admin/decorators/require-admin-permission.decorator';
import { AdminPermissionGuard } from '../../admin/guards/admin-permission.guard';
import {
  AdminIncidentListQueryDto,
  AdminSosListQueryDto,
  AdminSosNoteDto,
  AdminSosReasonDto,
} from './dto/admin-sos.dto';
import { AdminSosService } from './admin-sos.service';

@ApiTags('Admin SOS')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
@ApiForbiddenResponse({ description: 'Admin permission required' })
@Controller('admin')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
export class AdminSosController {
  constructor(private readonly adminSosService: AdminSosService) {}

  @Get('sos')
  @RequireAdminPermission(ADMIN_PERMISSION_SOS_VIEW)
  list(@Query() query: AdminSosListQueryDto) {
    return this.adminSosService.list(query);
  }

  @Get('sos/:sosId')
  @RequireAdminPermission(ADMIN_PERMISSION_SOS_VIEW)
  getOne(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('sosId', ParseUUIDPipe) sosId: string,
  ) {
    return this.adminSosService.getDetail(sosId, admin.userId);
  }

  @Get('sos/:sosId/locations')
  @RequireAdminPermission(ADMIN_PERMISSION_SOS_VIEW)
  locations(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('sosId', ParseUUIDPipe) sosId: string,
  ) {
    return this.adminSosService.getLocations(admin.userId, sosId);
  }

  @Post('sos/:sosId/acknowledge')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_SOS_MANAGE)
  acknowledge(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('sosId', ParseUUIDPipe) sosId: string,
  ) {
    return this.adminSosService.acknowledge(admin.userId, sosId);
  }

  @Post('sos/:sosId/start-response')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_SOS_MANAGE)
  startResponse(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('sosId', ParseUUIDPipe) sosId: string,
  ) {
    return this.adminSosService.startResponse(admin.userId, sosId);
  }

  @Post('sos/:sosId/resolve')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_SOS_MANAGE)
  resolve(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('sosId', ParseUUIDPipe) sosId: string,
    @Body() body: AdminSosReasonDto,
  ) {
    return this.adminSosService.resolve(admin.userId, sosId, body);
  }

  @Post('sos/:sosId/false-alarm')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_SOS_MANAGE)
  falseAlarm(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('sosId', ParseUUIDPipe) sosId: string,
    @Body() body: AdminSosReasonDto,
  ) {
    return this.adminSosService.falseAlarm(admin.userId, sosId, body);
  }

  @Post('sos/:sosId/notes')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_SOS_MANAGE)
  addNote(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('sosId', ParseUUIDPipe) sosId: string,
    @Body() body: AdminSosNoteDto,
  ) {
    return this.adminSosService.addNote(admin.userId, sosId, body);
  }

  @Get('incidents')
  @RequireAdminPermission(ADMIN_PERMISSION_INCIDENTS_VIEW)
  listIncidents(@Query() query: AdminIncidentListQueryDto) {
    return this.adminSosService.listIncidents(query);
  }

  @Get('incidents/:incidentId')
  @RequireAdminPermission(ADMIN_PERMISSION_INCIDENTS_VIEW)
  getIncident(@Param('incidentId', ParseUUIDPipe) incidentId: string) {
    return this.adminSosService.getIncident(incidentId);
  }

  @Post('incidents/:incidentId/acknowledge')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_INCIDENTS_MANAGE)
  acknowledgeIncident(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('incidentId', ParseUUIDPipe) incidentId: string,
  ) {
    return this.adminSosService.acknowledgeIncident(admin.userId, incidentId);
  }

  @Post('incidents/:incidentId/assign-to-me')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_INCIDENTS_MANAGE)
  assign(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('incidentId', ParseUUIDPipe) incidentId: string,
  ) {
    return this.adminSosService.assignIncidentToMe(admin.userId, incidentId);
  }

  @Post('incidents/:incidentId/escalate')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_INCIDENTS_MANAGE)
  escalate(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('incidentId', ParseUUIDPipe) incidentId: string,
  ) {
    return this.adminSosService.escalateIncident(admin.userId, incidentId);
  }

  @Post('incidents/:incidentId/resolve')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_INCIDENTS_MANAGE)
  resolveIncident(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('incidentId', ParseUUIDPipe) incidentId: string,
    @Body() body: AdminSosReasonDto,
  ) {
    return this.adminSosService.resolveIncident(admin.userId, incidentId, body);
  }

  @Post('incidents/:incidentId/notes')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_INCIDENTS_MANAGE)
  incidentNote(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('incidentId', ParseUUIDPipe) incidentId: string,
    @Body() body: AdminSosNoteDto,
  ) {
    return this.adminSosService.addIncidentNote(admin.userId, incidentId, body);
  }

  @Get('safety/live-monitoring/summary')
  @RequireAdminPermission(ADMIN_PERMISSION_SOS_VIEW)
  liveSummary() {
    return this.adminSosService.liveMonitoringSummary();
  }

  @Get('safety/live-monitoring/map')
  @RequireAdminPermission(ADMIN_PERMISSION_SOS_VIEW)
  liveMap() {
    return this.adminSosService.liveMonitoringMap();
  }

  @Get('safety/live-monitoring/active-sos')
  @RequireAdminPermission(ADMIN_PERMISSION_SOS_VIEW)
  liveActiveSos() {
    return this.adminSosService.liveMonitoringActiveSos();
  }
}
