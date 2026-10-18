import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminDriversService } from './admin-drivers.service';
import { ADMIN_PERMISSION_DRIVERS_VIEW } from './admin.constants';
import { RequireAdminPermission } from './decorators/require-admin-permission.decorator';
import {
  AdminDriverListQueryDto,
  AdminDriverPageDto,
} from './dto/admin-driver.dto';
import { AdminPermissionGuard } from './guards/admin-permission.guard';

@ApiTags('Admin Drivers')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
@ApiForbiddenResponse({ description: 'ADMIN_DRIVERS_VIEW required' })
@Controller('admin/drivers')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermission(ADMIN_PERMISSION_DRIVERS_VIEW)
export class AdminDriversController {
  constructor(private readonly driversService: AdminDriversService) {}

  @Get()
  @ApiOperation({
    summary: 'Paginated drivers directory',
    description:
      'Drivers = users with a vehicle, publish-eligible IDENTITY+VEHICLE verification, or at least one driven ride. Cancellation rate = cancelled / (completed + cancelled).',
  })
  @ApiOkResponse({ type: AdminDriverPageDto })
  list(@Query() query: AdminDriverListQueryDto) {
    return this.driversService.list(query);
  }

  @Get(':driverId')
  @ApiOperation({
    summary: 'Driver detail',
    description:
      'driverId is the linked user UUID (no separate driver entity). Insurance/fuel type are not in schema.',
  })
  @ApiNotFoundResponse({ description: 'ADMIN_DRIVER_NOT_FOUND' })
  getOne(@Param('driverId', ParseUUIDPipe) driverId: string) {
    return this.driversService.getDetail(driverId);
  }
}
