import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  AdminWithdrawalListQueryDto,
  AdminWithdrawalPageDto,
  AdminWithdrawalResponseDto,
  UpdateWithdrawalStatusDto,
} from '../wallet/dto/withdrawal.dto';
import { WithdrawalService } from '../wallet/withdrawal.service';
import { ADMIN_PERMISSION_WITHDRAWALS_MANAGE } from './admin.constants';
import { RequireAdminPermission } from './decorators/require-admin-permission.decorator';
import type { AdminUser } from './entities/admin-user.entity';
import { AdminPermissionGuard } from './guards/admin-permission.guard';

@ApiTags('Admin Withdrawals')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
@ApiForbiddenResponse({ description: 'Admin permission required' })
@Controller('admin/withdrawals')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermission(ADMIN_PERMISSION_WITHDRAWALS_MANAGE)
export class AdminWithdrawalsController {
  constructor(private readonly withdrawalService: WithdrawalService) {}

  @Get()
  @ApiOperation({ summary: 'List withdrawals (optionally filter by status)' })
  @ApiOkResponse({ type: AdminWithdrawalPageDto })
  list(@Query() query: AdminWithdrawalListQueryDto) {
    return this.withdrawalService.listForAdmin(query);
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Withdrawal detail with status history and payout details',
  })
  @ApiOkResponse({ type: AdminWithdrawalResponseDto })
  @ApiNotFoundResponse({ description: 'WITHDRAWAL_NOT_FOUND' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.withdrawalService.getForAdmin(id);
  }

  @Patch(':id/status')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Advance a withdrawal status',
    description:
      'INITIATED→PROCESSING, PROCESSING→COMPLETED (consumes the hold), INITIATED|PROCESSING→FAILED|CANCELLED (releases the hold once). COMPLETED is terminal.',
  })
  @ApiOkResponse({ type: AdminWithdrawalResponseDto })
  @ApiNotFoundResponse({ description: 'WITHDRAWAL_NOT_FOUND' })
  @ApiUnprocessableEntityResponse({
    description: 'INVALID_WITHDRAWAL_STATUS_TRANSITION',
  })
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWithdrawalStatusDto,
    @Req() request: { adminUser?: AdminUser },
  ) {
    return this.withdrawalService.updateStatus(
      { adminUserId: request.adminUser?.id ?? null },
      id,
      dto,
    );
  }
}
