import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  CorporateIdentitySendResponseDto,
  CorporateIdentityStatusResponseDto,
} from './dto/corporate-identity-response.dto';
import { SendCorporateIdentityDto } from './dto/send-corporate-identity.dto';
import { VerifyCorporateIdentityDto } from './dto/verify-corporate-identity.dto';
import { CorporateIdentityService } from './corporate-identity.service';

@ApiTags('Corporate identity')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('corporate-identity')
@UseGuards(JwtAuthGuard)
export class CorporateIdentityController {
  constructor(
    private readonly corporateIdentityService: CorporateIdentityService,
  ) {}

  @Post('send')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send a corporate identity verification OTP',
    description:
      'Validates that the email uses an allowed corporate domain, then sends a 4-digit OTP via the shared email verification infrastructure. Personal/free email domains are rejected with CORPORATE_EMAIL_NOT_ALLOWED.',
  })
  @ApiOkResponse({ type: CorporateIdentitySendResponseDto })
  @ApiUnprocessableEntityResponse({
    description: 'CORPORATE_EMAIL_NOT_ALLOWED',
  })
  @ApiTooManyRequestsResponse({
    description: 'EMAIL_VERIFICATION_COOLDOWN or EMAIL_VERIFICATION_RATE_LIMITED',
  })
  send(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: SendCorporateIdentityDto,
  ) {
    return this.corporateIdentityService.send(currentUser.userId, body.email);
  }

  @Post('verify')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify the corporate identity OTP',
    description:
      'Consumes a CORPORATE_IDENTITY purpose OTP and marks corporate identity VERIFIED. Does not modify users.email or users.email_verified.',
  })
  @ApiOkResponse({ type: CorporateIdentityStatusResponseDto })
  @ApiUnprocessableEntityResponse({
    description: 'CORPORATE_EMAIL_NOT_ALLOWED',
  })
  verify(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: VerifyCorporateIdentityDto,
  ) {
    return this.corporateIdentityService.verify(
      currentUser.userId,
      body.email,
      body.otp,
    );
  }

  @Get('status')
  @ApiOperation({ summary: 'Get corporate identity verification status' })
  @ApiOkResponse({ type: CorporateIdentityStatusResponseDto })
  status(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.corporateIdentityService.getStatus(currentUser.userId);
  }
}
