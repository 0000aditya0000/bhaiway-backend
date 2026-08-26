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
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CreateTopUpDto } from './dto/create-top-up.dto';
import { TopUpCallbackDto } from './dto/top-up-callback.dto';
import { TopUpOrderResponseDto } from './dto/top-up-order-response.dto';
import { WalletBalanceResponseDto } from './dto/wallet-balance-response.dto';
import { WalletTransactionQueryDto } from './dto/wallet-transaction-query.dto';
import { WalletTransactionPageDto } from './dto/wallet-transaction-response.dto';
import { MOCK_SIGNATURE_HEADER } from './payment/mock-payment.gateway';
import { TopUpService } from './top-up.service';
import { WalletHistoryService } from './wallet-history.service';
import { WalletQueryService } from './wallet-query.service';

@ApiTags('Wallet')
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly walletQueryService: WalletQueryService,
    private readonly walletHistoryService: WalletHistoryService,
    private readonly topUpService: TopUpService,
  ) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
  @ApiOperation({
    summary: 'Get authenticated user wallet balance',
    description:
      'Read-only. Returns BhaiWay Coin balances as integer strings (1 Coin = ₹1). Internal accounting uses points with identical values.',
  })
  @ApiOkResponse({ type: WalletBalanceResponseDto })
  @ApiNotFoundResponse({ description: 'Wallet or balance not found' })
  getBalance(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.walletQueryService.getBalanceForUser(currentUser.userId);
  }

  @Get('transactions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
  @ApiOperation({
    summary: 'List authenticated user wallet transactions',
    description:
      'Read-only paginated ledger history, newest first. Amounts are integer coin strings (1 Coin = ₹1).',
  })
  @ApiOkResponse({ type: WalletTransactionPageDto })
  @ApiNotFoundResponse({ description: 'Wallet not found' })
  getTransactions(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: WalletTransactionQueryDto,
  ) {
    return this.walletHistoryService.findTransactionsForUser(
      currentUser.userId,
      query,
    );
  }

  @Post('top-up')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
  @ApiOperation({
    summary: 'Create a wallet top-up payment order',
    description:
      'Creates a PENDING payment order for the authenticated user. Wallet credit occurs only after a verified gateway callback. Amount is an integer coin string (1 Coin = ₹1). Requires Idempotency-Key.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Client idempotency key for safe retries. Reusing the same key with a different amount returns 409.',
  })
  @ApiCreatedResponse({ type: TopUpOrderResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation failed or missing Idempotency-Key',
  })
  @ApiForbiddenResponse({
    description: 'Wallet is suspended or locked',
  })
  @ApiNotFoundResponse({ description: 'Wallet not found' })
  @ApiConflictResponse({
    description: 'Idempotency-Key reused with a different amount',
  })
  createTopUp(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: CreateTopUpDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.topUpService.createTopUp(
      currentUser.userId,
      dto,
      idempotencyKey,
    );
  }

  @Get('top-up/:orderId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
  @ApiOperation({
    summary: 'Get authenticated user top-up payment order status',
    description:
      'Read-only status poll. Does not credit the wallet; credits occur only through verified gateway callbacks.',
  })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOkResponse({ type: TopUpOrderResponseDto })
  @ApiNotFoundResponse({ description: 'Payment order not found' })
  getTopUpOrder(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.topUpService.getTopUpOrderForUser(currentUser.userId, orderId);
  }

  @Post('top-up/callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Payment gateway callback (mock)',
    description:
      'Gateway webhook endpoint. Authenticated via HMAC signature (x-payment-signature), not user JWT. Never credits wallet without verified signature and order validation.',
  })
  @ApiHeader({
    name: MOCK_SIGNATURE_HEADER,
    required: true,
    description: 'HMAC-SHA256 signature of the callback payload',
  })
  @ApiOkResponse({ type: TopUpOrderResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid callback payload or signature',
  })
  @ApiNotFoundResponse({ description: 'Payment order not found' })
  @ApiConflictResponse({
    description: 'Payment order is in a terminal non-success state',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Callback amount or currency mismatch',
  })
  processTopUpCallback(
    @Body() dto: TopUpCallbackDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    return this.topUpService.processCallback(dto, headers);
  }
}
