import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  CreatePaymentMethodDto,
  DeletePaymentMethodResponseDto,
  PaymentMethodResponseDto,
  UpdatePaymentMethodDto,
} from './dto/payment-method.dto';
import { PaymentMethodService } from './payment-method.service';

@ApiTags('Wallet Payment Methods')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('wallet/payment-methods')
@UseGuards(JwtAuthGuard)
export class WalletPaymentMethodsController {
  constructor(private readonly paymentMethodService: PaymentMethodService) {}

  @Post()
  @ApiOperation({
    summary: 'Save a payout method (UPI or bank account)',
    description:
      'Bank account numbers are encrypted at rest and only returned masked. Submitting an identical active method returns the existing one.',
  })
  @ApiCreatedResponse({ type: PaymentMethodResponseDto })
  @ApiBadRequestResponse({ description: 'INVALID_PAYMENT_METHOD' })
  async create(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: CreatePaymentMethodDto,
  ) {
    const { method } = await this.paymentMethodService.create(
      currentUser.userId,
      dto,
    );
    return method;
  }

  @Get()
  @ApiOperation({ summary: 'List active payout methods' })
  @ApiOkResponse({ type: PaymentMethodResponseDto, isArray: true })
  list(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.paymentMethodService.list(currentUser.userId);
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Get a payout method' })
  @ApiOkResponse({ type: PaymentMethodResponseDto })
  @ApiNotFoundResponse({ description: 'PAYMENT_METHOD_NOT_FOUND' })
  get(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.paymentMethodService.get(currentUser.userId, id);
  }

  @Patch(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Update a payout method' })
  @ApiOkResponse({ type: PaymentMethodResponseDto })
  @ApiNotFoundResponse({ description: 'PAYMENT_METHOD_NOT_FOUND' })
  update(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentMethodDto,
  ) {
    return this.paymentMethodService.update(currentUser.userId, id, dto);
  }

  @Delete(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Delete a payout method',
    description:
      'Hard-deleted when never used by a withdrawal; otherwise deactivated so withdrawal history stays intact.',
  })
  @ApiOkResponse({ type: DeletePaymentMethodResponseDto })
  @ApiNotFoundResponse({ description: 'PAYMENT_METHOD_NOT_FOUND' })
  remove(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.paymentMethodService.remove(currentUser.userId, id);
  }
}
