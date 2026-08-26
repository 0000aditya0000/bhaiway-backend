import {
  ApiBadRequestResponse,
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
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { UpdateDriverLocationDto } from './dto/update-driver-location.dto';
import { RideTrackingResponseDto } from './dto/ride-tracking-response.dto';
import { TrackingService } from './tracking.service';

@ApiTags('Tracking')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('tracking/rides')
@UseGuards(JwtAuthGuard)
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @Post(':id/location')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish driver live location (owning driver, IN_PROGRESS trip ride)',
    description:
      'Stores the latest GPS fix in Redis (TTL) for REGULAR and ASSURED rides. Does not write to PostgreSQL. Rejected before start, after complete/cancel, and for non-owners.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Ride id' })
  @ApiOkResponse({ type: RideTrackingResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid coordinates or non-trip-lifecycle ride',
  })
  @ApiNotFoundResponse({ description: 'Ride not found for this driver' })
  @ApiConflictResponse({
    description: 'Ride not IN_PROGRESS (or cancelled/completed)',
  })
  updateLocation(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDriverLocationDto,
  ) {
    return this.trackingService
      .updateDriverLocation(currentUser.userId, id, body)
      .then(({ throttled: _throttled, ...tracking }) => tracking);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get current driver location for a trip-lifecycle ride',
    description:
      'Available to the ride driver or a passenger with an active/completed booking on REGULAR or ASSURED rides. Returns `driverCoordinate` for the mobile map marker.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Ride id' })
  @ApiOkResponse({ type: RideTrackingResponseDto })
  @ApiNotFoundResponse({
    description: 'Ride not found or caller is not authorized',
  })
  getTracking(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.trackingService.getRideTracking(currentUser.userId, id);
  }
}
