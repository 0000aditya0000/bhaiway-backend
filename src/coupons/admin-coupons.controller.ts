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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  ADMIN_PERMISSION_COUPONS_MANAGE,
} from '../admin/admin.constants';
import { RequireAdminPermission } from '../admin/decorators/require-admin-permission.decorator';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import {
  AdminCouponListQueryDto,
  AssignCouponUsersDto,
  CreateCouponAdminDto,
  UpdateCouponAdminDto,
  UpdateCouponStatusDto,
} from './dto/admin-coupon.dto';
import { CouponsService } from './coupons.service';

@ApiTags('Admin Coupons')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid admin JWT' })
@Controller('admin/coupons')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermission(ADMIN_PERMISSION_COUPONS_MANAGE)
export class AdminCouponsController {
  constructor(private readonly couponsService: CouponsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a public or user-specific coupon' })
  create(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() body: CreateCouponAdminDto,
  ) {
    return this.couponsService.createAdmin(admin.userId, body);
  }

  @Get()
  @ApiOperation({ summary: 'List coupons (admin)' })
  list(@Query() query: AdminCouponListQueryDto) {
    return this.couponsService.listAdmin(query.page, query.limit);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Coupon detail with assignments, redemptions, issuances, audit',
  })
  @ApiOkResponse({ description: 'Admin coupon detail' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.couponsService.toAdminDetail(id);
  }

  @Post(':id/assignments')
  @ApiOperation({ summary: 'Assign USER_SPECIFIC coupon to additional users' })
  assign(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignCouponUsersDto,
  ) {
    return this.couponsService.assignUsers(id, admin.userId, body);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Activate or deactivate a coupon' })
  setStatus(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCouponStatusDto,
  ) {
    return this.couponsService.setActive(id, admin.userId, body.isActive);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update coupon fields. Omitted fields (including applicableTo) are preserved.',
  })
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCouponAdminDto,
  ) {
    return this.couponsService.updateAdmin(id, admin.userId, body);
  }
}
