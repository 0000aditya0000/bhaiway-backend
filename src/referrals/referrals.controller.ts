import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
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
import {
  ReferralPageDto,
  ReferralSummaryDto,
} from './dto/referral-response.dto';
import { ReferralService } from './referral.service';

class ReferralListQueryHttpDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

@ApiTags('Referrals')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('referrals')
@UseGuards(JwtAuthGuard)
export class ReferralsController {
  constructor(private readonly referralService: ReferralService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Get own referral code and earnings summary',
  })
  @ApiOkResponse({ type: ReferralSummaryDto })
  getSummary(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.referralService.getSummary(currentUser.userId);
  }

  @Get()
  @ApiOperation({
    summary: 'List users you referred (newest first)',
  })
  @ApiOkResponse({ type: ReferralPageDto })
  list(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: ReferralListQueryHttpDto,
  ) {
    return this.referralService.listForReferrer(
      currentUser.userId,
      query.page,
      query.limit,
    );
  }
}
