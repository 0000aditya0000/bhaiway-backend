import {
  Controller,
  Get,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { CashfreeKycService } from './cashfree-kyc.service';

@ApiTags('KYC')
@Controller(['api/kyc/aadhaar/digilocker', 'kyc/aadhaar/digilocker'])
export class CashfreeKycCallbackController {
  constructor(private readonly kycService: CashfreeKycService) {}

  @Get('callback')
  @ApiOperation({
    summary: 'Cashfree DigiLocker browser redirect callback',
    description:
      'Browser redirect target from Cashfree after DigiLocker flow. Public endpoint (no JWT). Validates session presence and renders safe HTML. Does not mark verification as complete; status check and webhooks remain authoritative.',
  })
  @ApiQuery({
    name: 'verification_id',
    required: false,
    description: 'Merchant unique verification ID provided when generating session',
  })
  @ApiQuery({
    name: 'reference_id',
    required: false,
    description: 'Cashfree verification reference ID',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Cashfree flow status (e.g. AUTHENTICATED, USER_DROPPED)',
  })
  @ApiOkResponse({
    description:
      'HTML response instructing user to return to mobile app. Verification remains in progress or verified.',
    schema: { type: 'string', example: '<!DOCTYPE html>...' },
  })
  @ApiBadRequestResponse({
    description: 'Missing verification_id in query parameters',
  })
  @ApiNotFoundResponse({
    description: 'Verification record not found for the given verification_id',
  })
  async handleCallback(
    @Query() query: Record<string, string | undefined>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const result = await this.kycService.handleRedirectCallback(query);
    res.status(result.statusCode);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return result.html;
  }
}
