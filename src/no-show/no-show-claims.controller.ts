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
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { NoShowClaimResponseDto } from './dto/no-show-claim-response.dto';
import { NoShowClaimsService } from './no-show-claims.service';

@ApiTags('No-Show Claims')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('no-show-claims')
@UseGuards(JwtAuthGuard)
export class NoShowClaimsController {
  constructor(private readonly noShowClaimsService: NoShowClaimsService) {}

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a pending No-Show claim (respondent only)',
    description:
      'The responding party confirms the No-Show. Settlement reuses existing cancellation and financial rules for the ride type. Idempotent when already approved. Timeout auto-approval uses the same settlement path.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: NoShowClaimResponseDto })
  @ApiNotFoundResponse({ description: 'Claim not found for this user' })
  @ApiConflictResponse({ description: 'Claim is no longer pending' })
  approve(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.noShowClaimsService.approve(currentUser.userId, id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a pending No-Show claim (respondent only)',
    description:
      'Rejects the claim with no cancellation, refund, penalty, or compensation. The claimant is notified and directed to Help & Support.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: NoShowClaimResponseDto })
  @ApiNotFoundResponse({ description: 'Claim not found for this user' })
  @ApiConflictResponse({ description: 'Claim is no longer pending' })
  reject(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.noShowClaimsService.reject(currentUser.userId, id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a No-Show claim (claimant or respondent)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: NoShowClaimResponseDto })
  @ApiNotFoundResponse({ description: 'Claim not found for this user' })
  getOne(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.noShowClaimsService.getClaim(currentUser.userId, id);
  }
}
