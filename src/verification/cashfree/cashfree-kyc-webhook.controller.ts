import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../../auth/decorators/public.decorator';
import { CashfreeKycService } from './cashfree-kyc.service';

@ApiTags('KYC')
@Public()
@Controller('api/kyc/webhooks/cashfree/digilocker')
export class CashfreeKycWebhookController {
  private readonly logger = new Logger(CashfreeKycWebhookController.name);

  constructor(private readonly kycService: CashfreeKycService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'Health check for Cashfree DigiLocker webhook route',
    description: 'Allows gateway and uptime ping verification without payload or authentication.',
  })
  healthCheck() {
    return {
      status: 'ok',
      endpoint: 'Cashfree DigiLocker Webhook',
      timestamp: new Date().toISOString(),
    };
  }

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cashfree DigiLocker KYC webhook endpoint',
    description:
      'Receives asynchronous Cashfree DigiLocker verification notifications. Authenticates HMAC-SHA256 signature using CASHFREE_CLIENT_SECRET against the raw request body. Never requires JWT authentication.',
  })
  @ApiHeader({
    name: 'x-webhook-signature',
    required: true,
    description: 'Cashfree HMAC-SHA256 Base64 signature',
  })
  @ApiHeader({
    name: 'x-webhook-timestamp',
    required: true,
    description: 'Epoch timestamp or ISO timestamp of the event',
  })
  @ApiOkResponse({ description: 'Webhook acknowledged' })
  @ApiBadRequestResponse({ description: 'Expired timestamp or malformed payload' })
  @ApiUnauthorizedResponse({ description: 'Invalid HMAC signature' })
  async handleWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ received: boolean; status?: string }> {
    let rawBody = req.rawBody;
    if (!rawBody) {
      if (Buffer.isBuffer(req.body)) {
        rawBody = req.body;
      } else if (typeof req.body === 'string') {
        rawBody = Buffer.from(req.body, 'utf8');
      } else if (
        req.body &&
        typeof req.body === 'object' &&
        req.body.type === 'Buffer' &&
        Array.isArray(req.body.data)
      ) {
        rawBody = Buffer.from(req.body.data);
      } else {
        rawBody = Buffer.from(JSON.stringify(req.body ?? {}));
      }
    }

    const headerKeys = Object.keys(headers || {});
    this.logger.log(
      `Incoming Cashfree webhook: rawBodyLength=${rawBody.length} bytes, headers=[${headerKeys.join(', ')}]`,
    );

    return this.kycService.processWebhook(rawBody, headers);
  }
}
