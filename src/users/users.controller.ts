import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CreateProfileDto } from './dto/create-profile.dto';
import {
  RequestEmailChangeResponseDto,
  VerifyEmailChangeResponseDto,
} from './dto/email-change-response.dto';
import { RequestEmailChangeDto } from './dto/request-email-change.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { GetMeResponseDto, ProfileResponseDto } from './dto/user-response.dto';
import { VerifyEmailChangeDto } from './dto/verify-email-change.dto';
import { EmailChangeService } from './email-change.service';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly emailChangeService: EmailChangeService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Get authenticated user and profile' })
  @ApiOkResponse({ type: GetMeResponseDto })
  @ApiNotFoundResponse({ description: 'User not found' })
  getMe(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.usersService.getMe(currentUser.userId);
  }

  @Post('profile')
  @ApiOperation({ summary: 'Create user profile' })
  @ApiCreatedResponse({ type: ProfileResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiConflictResponse({
    description: 'Profile already exists or email is already in use',
  })
  @ApiNotFoundResponse({ description: 'User not found' })
  createProfile(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: CreateProfileDto,
  ) {
    return this.usersService.createProfile(currentUser.userId, body);
  }

  @Patch(['profile', 'me/profile'])
  @ApiOperation({ summary: 'Update user profile (partial)' })
  @ApiOkResponse({ type: ProfileResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiNotFoundResponse({ description: 'Profile not found' })
  updateProfile(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(currentUser.userId, body);
  }

  @Post('me/email/change/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request OTP to change email address' })
  @ApiOkResponse({ type: RequestEmailChangeResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid email format or same as current email',
  })
  @ApiConflictResponse({
    description: 'Email already registered to another account',
  })
  @ApiTooManyRequestsResponse({
    description: 'Cooldown or hourly limit exceeded',
  })
  requestEmailChange(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: RequestEmailChangeDto,
  ) {
    return this.emailChangeService.requestEmailChange(
      currentUser.userId,
      body.newEmail,
    );
  }

  @Post('me/email/change/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify OTP and update email address' })
  @ApiOkResponse({ type: VerifyEmailChangeResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid OTP code, expired OTP, or email mismatch',
  })
  @ApiNotFoundResponse({
    description: 'No pending email change request found',
  })
  @ApiConflictResponse({
    description: 'Email claimed by another account before verification',
  })
  @ApiTooManyRequestsResponse({
    description: 'OTP attempts exceeded',
  })
  verifyEmailChange(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: VerifyEmailChangeDto,
  ) {
    return this.emailChangeService.verifyEmailChange(
      currentUser.userId,
      body.newEmail,
      body.otp,
    );
  }
}
