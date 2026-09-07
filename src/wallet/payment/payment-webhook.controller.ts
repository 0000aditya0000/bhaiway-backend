import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { RAZORPAY_SIGNATURE_HEADER } from './razorpay-payment.gateway';
import { TopUpService } from '../top-up.service';

@ApiTags('Payments')
@Controller('api/payments/gateway')
export class PaymentWebhookController {
  constructor(private readonly topUpService: TopUpService) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Payment gateway webhook (provider-agnostic route)',
    description:
      'Receives asynchronous gateway payment notifications. Verifies provider HMAC signature against the raw request body. Never requires JWT authentication. Safe against replay and concurrent deliveries.',
  })
  @ApiHeader({
    name: RAZORPAY_SIGNATURE_HEADER,
    required: false,
    description: 'Razorpay HMAC-SHA256 signature of the raw request payload',
  })
  @ApiOkResponse({ description: 'Webhook acknowledged' })
  @ApiBadRequestResponse({ description: 'Invalid signature or malformed payload' })
  async handleGatewayWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ received: boolean; status?: string }> {
    let rawBody = req.rawBody;
    if (!rawBody) {
      if (Buffer.isBuffer(req.body)) {
        rawBody = req.body;
      } else if (typeof req.body === 'string') {
        rawBody = Buffer.from(req.body, 'utf8');
      } else {
        rawBody = Buffer.from(JSON.stringify(req.body ?? {}));
      }
    }
    return this.topUpService.processGatewayWebhook(rawBody, headers);
  }
}
