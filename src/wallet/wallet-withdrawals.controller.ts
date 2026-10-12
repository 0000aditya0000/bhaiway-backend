import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  CreateWithdrawalDto,
  WithdrawalListQueryDto,
  WithdrawalPageDto,
  WithdrawalResponseDto,
} from './dto/withdrawal.dto';
import { WithdrawalService } from './withdrawal.service';

@ApiTags('Wallet Withdrawals')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletWithdrawalsController {
  constructor(private readonly withdrawalService: WithdrawalService) {}

  @Post('withdraw')
  @ApiOperation({
    summary: 'Request a manual withdrawal of earned Coins',
    description:
      'Reserves earned (driver) Coins with a wallet hold; an admin pays out manually and then completes or rejects the request. Purchased and promotional Coins are never withdrawable. Requires Idempotency-Key.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: WithdrawalResponseDto })
  @ApiBadRequestResponse({
    description: 'IDEMPOTENCY_KEY_REQUIRED / INVALID_WITHDRAWAL_AMOUNT',
  })
  @ApiNotFoundResponse({ description: 'PAYMENT_METHOD_NOT_FOUND' })
  @ApiConflictResponse({ description: 'WITHDRAWAL_IDEMPOTENCY_CONFLICT' })
  @ApiForbiddenResponse({ description: 'Wallet is suspended or locked' })
  @ApiUnprocessableEntityResponse({
    description:
      'INSUFFICIENT_WITHDRAWABLE_BALANCE / PAYMENT_METHOD_INACTIVE',
  })
  withdraw(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: CreateWithdrawalDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.withdrawalService.createWithdrawal(
      currentUser.userId,
      dto,
      idempotencyKey,
    );
  }

  @Get('withdrawals')
  @ApiOperation({ summary: 'List own withdrawals (newest first)' })
  @ApiOkResponse({ type: WithdrawalPageDto })
  list(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: WithdrawalListQueryDto,
  ) {
    return this.withdrawalService.listForUser(currentUser.userId, query);
  }

  @Get('withdrawals/:id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Get one of your withdrawals' })
  @ApiOkResponse({ type: WithdrawalResponseDto })
  @ApiNotFoundResponse({ description: 'WITHDRAWAL_NOT_FOUND' })
  @ApiForbiddenResponse({ description: 'WITHDRAWAL_ACCESS_DENIED' })
  get(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.withdrawalService.getForUser(currentUser.userId, id);
  }
}
