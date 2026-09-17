import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { CashfreeKycService } from './cashfree-kyc.service';
import {
  CashfreeKycStatusResponseDto,
  CashfreeStartVerificationResponseDto,
} from './dto/cashfree-kyc-response.dto';

@ApiTags('KYC')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('kyc/aadhaar/digilocker')
@UseGuards(JwtAuthGuard)
export class CashfreeKycController {
  constructor(private readonly kycService: CashfreeKycService) {}

  @Post('start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start or reuse Cashfree DigiLocker Aadhaar verification session',
    description:
      'Creates a Cashfree DigiLocker verification session and returns the authorization URL. Reuses active session if valid. Rejects if user is already identity verified.',
  })
  @ApiOkResponse({ type: CashfreeStartVerificationResponseDto })
  @ApiConflictResponse({ description: 'User identity is already verified' })
  start(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.kycService.startVerification(currentUser.userId);
  }

  @Get('status')
  @ApiOperation({
    summary: 'Get Aadhaar verification status for the authenticated user',
    description:
      'Returns mobile-friendly verification status without exposing secrets or raw Aadhaar numbers.',
  })
  @ApiOkResponse({ type: CashfreeKycStatusResponseDto })
  status(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.kycService.getVerificationStatus(currentUser.userId);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh status from Cashfree and finalize document verification',
    description:
      'Polls Cashfree for latest status. If authenticated, retrieves Aadhaar document, updates UserProfile, and marks identity as VERIFIED.',
  })
  @ApiOkResponse({ type: CashfreeKycStatusResponseDto })
  @ApiNotFoundResponse({ description: 'No verification session found' })
  refresh(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.kycService.refreshVerification(currentUser.userId);
  }
}
