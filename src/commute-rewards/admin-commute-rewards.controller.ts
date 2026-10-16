import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ADMIN_PERMISSION_COMMUTE_REWARDS_MANAGE } from '../admin/admin.constants';
import { RequireAdminPermission } from '../admin/decorators/require-admin-permission.decorator';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CommuteRewardsService } from './commute-rewards.service';
import {
  CreateCommuteRewardCampaignDto,
  CreateCommuteRewardMilestoneDto,
  FulfilCommuteRewardClaimDto,
  ReviewCommuteRewardClaimDto,
  UpdateCommuteRewardCampaignDto,
  UpdateCommuteRewardMilestoneDto,
  CommuteRewardListQueryDto,
} from './dto/admin-commute-reward.dto';
import {
  CommuteRewardCampaignStatus,
  CommuteRewardClaimStatus,
} from './enums/commute-reward.enums';

class AdminClaimsQueryDto {
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
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: CommuteRewardClaimStatus })
  @IsOptional()
  @IsEnum(CommuteRewardClaimStatus)
  status?: CommuteRewardClaimStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  campaignId?: string;
}

class SetStatusDto {
  @ApiProperty({ enum: CommuteRewardCampaignStatus })
  @IsEnum(CommuteRewardCampaignStatus)
  status!: CommuteRewardCampaignStatus;
}

@ApiTags('Admin Commute Rewards')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid admin JWT' })
@Controller('admin/commute-rewards')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
@RequireAdminPermission(ADMIN_PERMISSION_COMMUTE_REWARDS_MANAGE)
export class AdminCommuteRewardsController {
  constructor(private readonly rewardsService: CommuteRewardsService) {}

  @Post('campaigns')
  @ApiOperation({ summary: 'Create DRAFT Office Commute reward campaign' })
  create(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() body: CreateCommuteRewardCampaignDto,
  ) {
    return this.rewardsService.createCampaign(admin.userId, body);
  }

  @Get('campaigns')
  @ApiOperation({ summary: 'List reward campaigns' })
  list(@Query() query: CommuteRewardListQueryDto) {
    return this.rewardsService.listCampaigns(query.page, query.limit, query.status);
  }

  @Get('campaigns/:id')
  @ApiOperation({ summary: 'Campaign detail with milestones' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.rewardsService.getCampaignDetail(id);
  }

  @Patch('campaigns/:id')
  @ApiOperation({ summary: 'Update campaign (schedule only in DRAFT)' })
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCommuteRewardCampaignDto,
  ) {
    return this.rewardsService.updateCampaign(admin.userId, id, body);
  }

  @Post('campaigns/:id/milestones')
  @ApiOperation({ summary: 'Add milestone (DRAFT only)' })
  addMilestone(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateCommuteRewardMilestoneDto,
  ) {
    return this.rewardsService.addMilestone(admin.userId, id, body);
  }

  @Patch('campaigns/:campaignId/milestones/:milestoneId')
  @ApiOperation({ summary: 'Edit milestone (DRAFT only)' })
  updateMilestone(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Param('milestoneId', ParseUUIDPipe) milestoneId: string,
    @Body() body: UpdateCommuteRewardMilestoneDto,
  ) {
    return this.rewardsService.updateMilestone(
      admin.userId,
      campaignId,
      milestoneId,
      body,
    );
  }

  @Patch('campaigns/:id/status')
  @ApiOperation({
    summary: 'Activate / pause / resume / end / archive campaign',
  })
  setStatus(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetStatusDto,
  ) {
    return this.rewardsService.setCampaignStatus(admin.userId, id, body.status);
  }

  @Get('campaigns/:id/drivers')
  @ApiOperation({ summary: 'Driver progress for a campaign' })
  drivers(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CommuteRewardListQueryDto,
  ) {
    return this.rewardsService.listDriverProgressAdmin(
      id,
      query.page,
      query.limit,
    );
  }

  @Get('campaigns/:id/audit')
  @ApiOperation({ summary: 'Campaign audit history' })
  audit(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CommuteRewardListQueryDto,
  ) {
    return this.rewardsService.listAudit(id, query.page, query.limit);
  }

  @Get('claims')
  @ApiOperation({ summary: 'List reward claims' })
  claims(@Query() query: AdminClaimsQueryDto) {
    return this.rewardsService.listClaimsAdmin(
      query.page,
      query.limit,
      query.status,
      query.campaignId,
    );
  }

  @Post('claims/:id/review')
  @ApiOperation({ summary: 'Approve or reject a claim' })
  review(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewCommuteRewardClaimDto,
  ) {
    return this.rewardsService.reviewClaim(admin.userId, id, body);
  }

  @Post('claims/:id/fulfil')
  @ApiOperation({ summary: 'Mark an approved claim as fulfilled (prize delivered)' })
  fulfil(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: FulfilCommuteRewardClaimDto,
  ) {
    return this.rewardsService.fulfilClaim(admin.userId, id, body);
  }
}
