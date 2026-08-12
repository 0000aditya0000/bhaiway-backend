import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CreateProfileDto } from './dto/create-profile.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  GetMeResponseDto,
  ProfileResponseDto,
} from './dto/user-response.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

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
  @ApiConflictResponse({ description: 'Profile already exists' })
  @ApiNotFoundResponse({ description: 'User not found' })
  createProfile(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: CreateProfileDto,
  ) {
    return this.usersService.createProfile(currentUser.userId, body);
  }

  @Patch('profile')
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
}
