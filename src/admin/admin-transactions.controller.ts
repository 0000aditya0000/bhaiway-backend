import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
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
  AdminReverseTransactionDto,
  AdminReverseTransactionResponseDto,
  AdminTransactionDetailDto,
  AdminTransactionListQueryDto,
  AdminTransactionPageDto,
} from '../wallet/dto/admin-transaction.dto';
import {
  ADMIN_PERMISSION_TRANSACTIONS_REVERSE,
  ADMIN_PERMISSION_TRANSACTIONS_VIEW,
} from './admin.constants';
import { AdminTransactionsService } from './admin-transactions.service';
import { RequireAdminPermission } from './decorators/require-admin-permission.decorator';
import type { AdminUser } from './entities/admin-user.entity';
import { AdminPermissionGuard } from './guards/admin-permission.guard';

@ApiTags('Admin Transactions')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
@ApiForbiddenResponse({ description: 'Admin permission required' })
@Controller('admin/transactions')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
export class AdminTransactionsController {
  constructor(private readonly transactionsService: AdminTransactionsService) {}

  @Get()
  @RequireAdminPermission(ADMIN_PERMISSION_TRANSACTIONS_VIEW)
  @ApiOperation({
    summary: 'List wallet ledger transactions (cross-user, paginated)',
  })
  @ApiOkResponse({ type: AdminTransactionPageDto })
  list(@Query() query: AdminTransactionListQueryDto) {
    return this.transactionsService.list(query);
  }

  @Get(':transactionId')
  @RequireAdminPermission(ADMIN_PERMISSION_TRANSACTIONS_VIEW)
  @ApiParam({ name: 'transactionId', format: 'uuid' })
  @ApiOperation({ summary: 'Wallet ledger transaction detail' })
  @ApiOkResponse({ type: AdminTransactionDetailDto })
  @ApiNotFoundResponse({ description: 'ADMIN_TRANSACTION_NOT_FOUND' })
  getOne(@Param('transactionId', ParseUUIDPipe) transactionId: string) {
    return this.transactionsService.getDetail(transactionId);
  }

  @Post(':transactionId/reverse')
  @HttpCode(200)
  @RequireAdminPermission(ADMIN_PERMISSION_TRANSACTIONS_REVERSE)
  @ApiParam({ name: 'transactionId', format: 'uuid' })
  @ApiOperation({
    summary: 'Post a compensating admin reversal for an eligible ledger row',
    description:
      'Does not mutate the original POSTED row. Creates ADMIN_ADJUSTMENT credit/debit linked via parent_transaction_id and reference_type=ADMIN_TX_REVERSAL. Idempotent on repeated calls.',
  })
  @ApiOkResponse({ type: AdminReverseTransactionResponseDto })
  @ApiNotFoundResponse({ description: 'ADMIN_TRANSACTION_NOT_FOUND' })
  @ApiUnprocessableEntityResponse({
    description: 'ADMIN_TRANSACTION_NOT_REVERSIBLE or insufficient balance',
  })
  @ApiConflictResponse({ description: 'ADMIN_TRANSACTION_ALREADY_REVERSED' })
  reverse(
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
    @Body() body: AdminReverseTransactionDto,
    @Req() request: { adminUser?: AdminUser; user?: { userId: string } },
  ) {
    const adminUserId =
      request.adminUser?.userId ?? request.user?.userId ?? 'unknown';
    return this.transactionsService.reverse(transactionId, adminUserId, body);
  }
}
