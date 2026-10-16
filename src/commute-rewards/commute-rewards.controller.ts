import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CommuteRewardsService } from './commute-rewards.service';

class DriverListQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

@ApiTags('Commute Rewards')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('commute-rewards')
@UseGuards(JwtAuthGuard)
export class CommuteRewardsController {
  constructor(private readonly rewardsService: CommuteRewardsService) {}

  @Get('campaigns')
  @ApiOperation({
    summary: 'List active Office Commute reward campaigns with own progress',
  })
  listActive(@CurrentUser() user: AuthenticatedUser) {
    return this.rewardsService.listActiveForDriver(user.userId);
  }

  @Get('campaigns/:id')
  @ApiOperation({ summary: 'Campaign details + authenticated driver progress' })
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.rewardsService.getDriverCampaign(user.userId, id);
  }

  @Get('campaigns/:id/progress')
  @ApiOperation({ summary: 'Own progress for a campaign' })
  progress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.rewardsService.buildDriverProgress(id, user.userId);
  }

  @Post('campaigns/:campaignId/milestones/:milestoneId/claims')
  @ApiOperation({ summary: 'Submit a reward claim for an eligible milestone' })
  claim(
    @CurrentUser() user: AuthenticatedUser,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Param('milestoneId', ParseUUIDPipe) milestoneId: string,
  ) {
    return this.rewardsService.claimMilestone(
      user.userId,
      campaignId,
      milestoneId,
    );
  }

  @Get('claims')
  @ApiOperation({ summary: 'Own claim history' })
  claims(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DriverListQueryDto,
  ) {
    return this.rewardsService.listDriverClaims(
      user.userId,
      query.page,
      query.limit,
    );
  }
}
