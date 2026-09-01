import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  PendingRatingsPageDto,
  SkipRatingResponseDto,
  SubmitRatingResponseDto,
  UserRatingsSummaryDto,
} from './dto/rating-response.dto';
import { SubmitRatingDto } from './dto/submit-rating.dto';
import { UserRatingsQueryDto } from './dto/user-ratings-query.dto';
import { RatingsService } from './ratings.service';

@ApiTags('Ratings')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('ratings')
@UseGuards(JwtAuthGuard)
export class RatingsController {
  constructor(private readonly ratingsService: RatingsService) {}

  @Get('pending')
  @ApiOperation({
    summary: 'List pending rating tasks for the authenticated user',
    description:
      'Returns PENDING tasks where the JWT subject is fromUserId, including skipped tasks still eligible for reminders.',
  })
  @ApiOkResponse({ type: PendingRatingsPageDto })
  findPending(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.ratingsService.findPendingForUser(currentUser.userId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit a rating for a pending task',
    description:
      'Uses taskId to bind ride/booking/target. Idempotent when the same rating is resubmitted.',
  })
  @ApiOkResponse({ type: SubmitRatingResponseDto })
  @ApiNotFoundResponse({ description: 'Task not found for this user' })
  @ApiConflictResponse({
    description: 'Task not pending or rating already submitted with different payload',
  })
  submit(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: SubmitRatingDto,
  ) {
    return this.ratingsService.submitRating(currentUser.userId, body);
  }

  @Post(':taskId/skip')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Skip a pending rating (remains PENDING for future reminders)',
    description:
      'Does not complete the task. Records skippedAt on first skip; idempotent on retries.',
  })
  @ApiParam({ name: 'taskId', format: 'uuid' })
  @ApiOkResponse({ type: SkipRatingResponseDto })
  @ApiNotFoundResponse({ description: 'Task not found for this user' })
  @ApiConflictResponse({ description: 'Task is not pending' })
  skip(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ) {
    return this.ratingsService.skipRating(currentUser.userId, taskId);
  }

  @Get('user/:userId')
  @ApiOperation({
    summary: 'Received ratings summary for a user',
    description:
      'Server-side average and paginated completed ratings. Pending/skipped tasks are excluded.',
  })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiOkResponse({ type: UserRatingsSummaryDto })
  getUserRatings(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: UserRatingsQueryDto,
  ) {
    return this.ratingsService.getUserRatingsSummary(userId, query);
  }
}
