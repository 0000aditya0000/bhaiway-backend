import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { SubmitVerificationDto } from './dto/submit-verification.dto';
import {
  MyVerificationsResponseDto,
  VerificationStatusViewDto,
} from './dto/verification-response.dto';
import { VerificationService } from './verification.service';

@ApiTags('Verification')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('verification')
@UseGuards(JwtAuthGuard)
export class VerificationController {
  constructor(private readonly verificationService: VerificationService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Get current verification statuses',
    description:
      'Returns identity, driving license, and vehicle verification status for the authenticated user. Unsubmitted types appear as PENDING. Does not expose provider secrets or raw provider responses.',
  })
  @ApiOkResponse({ type: MyVerificationsResponseDto })
  getMe(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.verificationService.getMyVerifications(currentUser.userId);
  }

  @Post('identity')
  @ApiOperation({
    summary: 'Submit identity verification',
    description:
      'Creates an identity verification submission. Outcome is determined by the verification provider. Clients cannot set VERIFIED status.',
  })
  @ApiCreatedResponse({ type: VerificationStatusViewDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiConflictResponse({
    description: 'An active identity verification already exists',
  })
  submitIdentity(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: SubmitVerificationDto,
  ) {
    return this.verificationService.submitIdentityVerification(
      currentUser.userId,
      body,
    );
  }

  @Post('driving-license')
  @ApiOperation({
    summary: 'Submit driving license verification',
    description:
      'Creates a driving license verification submission. Outcome is determined by the verification provider. Clients cannot set VERIFIED status.',
  })
  @ApiCreatedResponse({ type: VerificationStatusViewDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiConflictResponse({
    description: 'An active driving license verification already exists',
  })
  submitDrivingLicense(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: SubmitVerificationDto,
  ) {
    return this.verificationService.submitDrivingLicenseVerification(
      currentUser.userId,
      body,
    );
  }

  @Post('vehicle')
  @ApiOperation({
    summary: 'Submit vehicle verification',
    description:
      'Creates a vehicle verification submission. Outcome is determined by the verification provider. Clients cannot set VERIFIED status.',
  })
  @ApiCreatedResponse({ type: VerificationStatusViewDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiConflictResponse({
    description: 'An active vehicle verification already exists',
  })
  submitVehicle(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: SubmitVerificationDto,
  ) {
    return this.verificationService.submitVehicleVerification(
      currentUser.userId,
      body,
    );
  }
}
