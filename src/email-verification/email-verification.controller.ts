import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  EmailVerificationActionResponseDto,
  EmailVerificationStatusResponseDto,
} from './dto/email-verification-response.dto';
import { SendEmailVerificationDto } from './dto/send-email-verification.dto';
import { VerifyEmailVerificationDto } from './dto/verify-email-verification.dto';
import { EmailVerificationService } from './email-verification.service';

@ApiTags('Email verification')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('users/email-verification')
@UseGuards(JwtAuthGuard)
export class EmailVerificationController {
  constructor(
    private readonly emailVerificationService: EmailVerificationService,
  ) {}

  @Post('send')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a 4-digit email verification OTP' })
  @ApiOkResponse({ type: EmailVerificationActionResponseDto })
  @ApiConflictResponse({ description: 'EMAIL_ALREADY_VERIFIED' })
  @ApiForbiddenResponse({ description: 'EMAIL_MISMATCH' })
  @ApiTooManyRequestsResponse({
    description: 'EMAIL_VERIFICATION_COOLDOWN or EMAIL_VERIFICATION_RATE_LIMITED',
  })
  send(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: SendEmailVerificationDto,
  ) {
    return this.emailVerificationService.sendCode(
      currentUser.userId,
      body.email,
    );
  }

  @Post('verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify the email OTP for the authenticated user' })
  @ApiOkResponse({ type: EmailVerificationActionResponseDto })
  @ApiBadRequestResponse({
    description: 'EMAIL_VERIFICATION_INVALID or EMAIL_VERIFICATION_EXPIRED',
  })
  @ApiNotFoundResponse({ description: 'EMAIL_VERIFICATION_NOT_FOUND' })
  @ApiTooManyRequestsResponse({
    description: 'EMAIL_VERIFICATION_ATTEMPTS_EXCEEDED',
  })
  verify(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: VerifyEmailVerificationDto,
  ) {
    return this.emailVerificationService.verifyCode(
      currentUser.userId,
      body.otp,
    );
  }

  @Get('status')
  @ApiOperation({ summary: 'Get email verification status' })
  @ApiOkResponse({ type: EmailVerificationStatusResponseDto })
  status(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.emailVerificationService.getStatus(currentUser.userId);
  }
}
