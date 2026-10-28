import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  AssuredRideLifecycleResponseDto,
  HalfTimeDecisionResponseDto,
} from '../assured/dto/assured-lifecycle-response.dto';
import { HalfTimeDecisionDto } from '../assured/dto/half-time-decision.dto';
import { NoShowClaimResponseDto } from '../no-show/dto/no-show-claim-response.dto';
import { CompleteRideResponseDto } from './dto/complete-ride-response.dto';
import { CreateRideDto } from './dto/create-ride.dto';
import { RideHistoryQueryDto } from './dto/ride-history-query.dto';
import {
  RideHistoryDetailDto,
  RideHistoryPageDto,
} from './dto/ride-history-response.dto';
import { RideResponseDto } from './dto/ride-response.dto';
import {
  RideSearchItemDto,
  RideSearchPageDto,
} from './dto/ride-search-response.dto';
import {
  RequestRouteOptionsDto,
  RouteOptionsResponseDto,
} from './dto/route-options.dto';
import { SearchRidesDto } from './dto/search-rides.dto';
import { UpdateRideDto } from './dto/update-ride.dto';
import { CancelRideQueryDto } from './dto/cancel-ride-query.dto';
import { SeriesScope } from './enums/ride.enums';
import { RidesService } from './rides.service';

@ApiTags('Rides')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('rides')
@UseGuards(JwtAuthGuard)
export class RidesController {
  constructor(private readonly ridesService: RidesService) {}

  @Post()
  @ApiOperation({
    summary: 'Publish a ride',
    description:
      'Creates a PUBLISHED REGULAR or COMMUTE ride, or an Assured (ASSURANCE_ACTIVE / ASSURANCE_PENDING) ride after verification checks. ' +
      'COMMUTE: pricePerSeat is the driver-published base fare; riderPricePerSeat (+10%) is computed server-side for passenger APIs. ' +
      'COMMUTE recurring=true generates independently bookable rides for the publishing date plus the next six Asia/Kolkata calendar dates, skipping excludeWeekdays. ' +
      'COMMUTE returnEnabled=true creates a same-date reverse-direction ride per eligible outbound date; requires returnDepartureTime (strictly later) and a separate reverse returnRouteSelectionToken. ' +
      'Recurring/return publishes require Idempotency-Key. Single COMMUTE/REGULAR still work without it. ' +
      'ASSURED publishing atomically creates an ACTIVE driver ASSURED_DEPOSIT wallet hold based on totalPublishedSeats × pricePerSeat × admin deposit %. ' +
      'All types require source/destination coordinates and routeSelectionToken from POST /rides/route-options. ' +
      'Assured also requires Idempotency-Key. driverId/status/availableSeats are server-controlled.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Required for ASSURED and for COMMUTE recurring/return series publishes. Optional for single-date COMMUTE (honoured when sent). Safe to retry the same payload with the same key; reusing a key with a different payload returns 409. Regular rides ignore this header.',
  })
  @ApiCreatedResponse({ type: RideResponseDto })
  @ApiBadRequestResponse({
    description:
      'Validation failed, or missing Assured coordinates/route geometry',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Insufficient wallet balance for Assured driver deposit',
  })
  @ApiConflictResponse({
    description:
      'Idempotency key reused with a different Assured publish payload',
  })
  @ApiForbiddenResponse({
    description: 'Driver or vehicle is not eligible to publish',
  })
  create(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: CreateRideDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.ridesService.create(currentUser.userId, body, {
      idempotencyKey,
    });
  }

  @Post('route-options')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List selectable driving routes between two coordinates',
    description:
      'Calls the configured directions provider with alternatives enabled. ' +
      'Each option includes a signed, expiring selectionToken to pass as routeSelectionToken when publishing or changing a route. ' +
      'Does not invent extra alternatives. Geometry is not persisted until the driver publishes a selection.',
  })
  @ApiOkResponse({ type: RouteOptionsResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid coordinates' })
  listRouteOptions(@Body() body: RequestRouteOptionsDto) {
    return this.ridesService.listRouteOptions(body);
  }

  @Get('search')
  @ApiOperation({
    summary: 'Search published rides (passenger discovery)',
    description:
      'Read-only search of passenger-visible rides. REGULAR: status PUBLISHED. COMMUTE: status PUBLISHED (includes riderPricePerSeat = driver fare + 10%). ' +
      'ASSURED: status ASSURANCE_ACTIVE with available seats (ASSURANCE_PENDING is excluded). ' +
      'Optional rideType filters REGULAR, COMMUTE, or ASSURED; when omitted, all visible types are returned. ' +
      'With pickup/dropoff coordinates, matching uses the driver-selected driving route: 50km source catchment near A (forward only, first 50km of route progress), otherwise 20km corridor, dropoff within 20km and after pickup, never reverse. ' +
      'Rides without stored driving geometry are excluded from coordinate search (no straight-line fallback). ' +
      'COMMUTE corridor search also returns routeMatchPercentage (0–100) per matching ride; the score does not override eligibility. ' +
      'Without coordinates, filters by source/destination place-name contains. Also filters by date, optional time (at/after), and seats. Paginated. ' +
      'Each item includes vehicle details plus driver.rating (as-driver averages) and driver.recentRides (last 5 COMPLETED/CANCELLED).',
  })
  @ApiOkResponse({ type: RideSearchPageDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  search(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: SearchRidesDto,
  ) {
    return this.ridesService.search(currentUser.userId, query);
  }

  @Get('my')
  @ApiOperation({
    summary: 'List rides created by the authenticated driver',
  })
  @ApiOkResponse({ type: RideResponseDto, isArray: true })
  findMine(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.ridesService.findMine(currentUser.userId);
  }

  @Get('history')
  @ApiOperation({
    summary: 'Paginated past rides for the authenticated driver',
    description:
      'Returns COMPLETED and CANCELLED rides owned by the JWT subject only. PUBLISHED and IN_PROGRESS are excluded. Includes vehicle details, route distance when stored, trip duration when pickup+completion timestamps exist, and an earnings breakdown (passengerTotal, driverShare, platformShare, bonuses).',
  })
  @ApiOkResponse({ type: RideHistoryPageDto })
  @ApiBadRequestResponse({ description: 'Invalid query parameters' })
  findHistory(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: RideHistoryQueryDto,
  ) {
    return this.ridesService.findHistory(currentUser.userId, query);
  }

  @Get('history/:id')
  @ApiOperation({
    summary: 'Past ride detail for the owning driver',
    description:
      'Includes passengers, vehicle information, distance/duration when available, and earnings breakdown from real bookings/ledger. Only COMPLETED/CANCELLED rides owned by the JWT subject.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: RideHistoryDetailDto })
  @ApiNotFoundResponse({
    description: 'Past ride not found for this driver',
  })
  findHistoryDetail(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ridesService.findHistoryDetail(currentUser.userId, id);
  }

  @Get('public/:id')
  @ApiOperation({
    summary: 'Passenger-facing public ride detail',
    description:
      'Returns safe public fields for a passenger-visible ride (REGULAR: PUBLISHED; COMMUTE: PUBLISHED with riderPricePerSeat; ASSURED: ASSURANCE_ACTIVE with seats). ' +
      'COMMUTE exposes pricePerSeat (driver base fare) and riderPricePerSeat (passenger fare, +10% markup — not a separate platform fee). ' +
      'Assured rides include assuredDepositAmount and assuredDepositPercentage from the publish-time snapshot. ' +
      'Includes vehicle details, driver.rating (as-driver averages), and driver.recentRides (last 5 COMPLETED/CANCELLED). ' +
      'Does not expose phones, emails, wallet, or verification documents.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: RideSearchItemDto })
  @ApiNotFoundResponse({
    description: 'Passenger-visible ride not found',
  })
  findPublishedPublic(@Param('id', ParseUUIDPipe) id: string) {
    return this.ridesService.findPublishedPublic(id);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a ride (owning driver only)',
    description:
      'REGULAR, ASSURED, and COMMUTE trip-lifecycle rides: requires IN_PROGRESS and all confirmed passengers PICKED_UP, then COMPLETED. ASSURED also releases ACTIVE deposit holds and may apply partial-fill compensation. ' +
      'COMMUTE: settles only CONFIRMED prepaid bookings (driver share + BhaiWay margin); PENDING requests are not settled. ' +
      'Rider fare is never debited again at completion. Safe to retry when already COMPLETED.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CompleteRideResponseDto })
  @ApiNotFoundResponse({
    description: 'Ride not found or not owned by the authenticated driver',
  })
  @ApiConflictResponse({
    description:
      'Invalid state (not started Regular ride, passengers waiting, cancelled, draft, or Assured hold issue)',
  })
  complete(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ridesService.complete(currentUser.userId, id);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start a trip-lifecycle ride (owning driver only)',
    description:
      'PUBLISHED → IN_PROGRESS for REGULAR, ASSURED, and COMMUTE rides. Ensures pickup OTPs exist for confirmed passengers. Zero passengers is allowed. Status cannot be set via PATCH.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: RideResponseDto })
  @ApiNotFoundResponse({
    description: 'Ride not found or not owned by the authenticated driver',
  })
  @ApiBadRequestResponse({
    description: 'Ride type does not support trip start',
  })
  @ApiConflictResponse({
    description: 'Already in progress, cancelled, completed, or invalid status',
  })
  start(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ridesService.startByDriver(currentUser.userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a published ride (owning driver only)',
    description:
      'REGULAR: cancels the ride and all active passenger bookings (RIDE_CANCELLED). No wallet deposit/refund processing. ' +
      'COMMUTE: refunds prepaid rider fares via CommuteCancellationService. Optional seriesScope=THIS_AND_FUTURE also cancels later unbooked same-direction occurrences; booked future dates are skipped. ' +
      'If the selected occurrence is IN_PROGRESS, THIS_AND_FUTURE returns 409 COMMUTE_SERIES_OCCURRENCE_IN_PROGRESS and does not cancel any sibling. ' +
      'ASSURED: before scheduled departure consumes driver ASSURED_DEPOSIT, releases affected rider deposits, distributes 60/40 compensation, refunds Assured PAY_NOW fares separately, issues NEXT_ASSURED_DEPOSIT_FREE coupons, cancels bookings, and advances the queue when applicable. Idempotent when already cancelled with the same reason. Status cannot be set via PATCH.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AssuredRideLifecycleResponseDto })
  @ApiNotFoundResponse({
    description: 'Ride not found or not owned by the authenticated driver',
  })
  @ApiConflictResponse({
    description: 'Invalid timing/state (after departure, completed, etc.)',
  })
  @ApiBadRequestResponse({
    description: 'Assured-only timing/rules violations for Assured rides',
  })
  cancel(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CancelRideQueryDto,
  ) {
    return this.ridesService.cancelByDriver(
      currentUser.userId,
      id,
      query.seriesScope ?? SeriesScope.THIS_OCCURRENCE,
    );
  }

  @Post(':id/no-show/driver')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Report that the driver did not arrive (passenger)',
    description:
      'Creates a pending No-Show claim 5 minutes after scheduled Asia/Kolkata departure if this passenger has not been picked up. IN_PROGRESS does not block the claim. The driver has 15 minutes to approve or reject. No GPS or photo evidence. Duplicate pending reports return the existing claim. Compatibility: POST /rides/:id/driver-no-show is the same action and no longer settles immediately.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: NoShowClaimResponseDto })
  @ApiNotFoundResponse({
    description: 'Ride not found for this reporter',
  })
  @ApiConflictResponse({
    description:
      'Too early, already picked up, cancelled/completed, or ineligible booking',
  })
  reportDriverNoShowClaim(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ridesService.reportDriverNoShow(currentUser.userId, id);
  }

  @Post(':id/driver-no-show')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Report driver no-show (compat — creates a pending claim)',
    description:
      'Compatibility alias for POST /rides/:id/no-show/driver. Previously settled Assured no-show immediately; it now opens a 15-minute claim so clients cannot bypass the response window. Settlement still uses the existing Assured DRIVER_NO_SHOW financial path after approval or timeout.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: NoShowClaimResponseDto })
  @ApiNotFoundResponse({
    description: 'Ride not found for this reporter',
  })
  @ApiConflictResponse({
    description:
      'Too early, already picked up, cancelled/completed, or ineligible booking',
  })
  reportDriverNoShow(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ridesService.reportDriverNoShow(currentUser.userId, id);
  }

  @Post(':id/half-time-decision')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set Assured half-time regular-seats policy (owning driver)',
    description:
      'Half-time is computed server-side as createdAt + (departure − createdAt) / 2. Before half-time → 409. Choices: ALLOW_REGULAR_RIDERS or KEEP_ASSURED_ONLY. If the driver never decides, effective default is KEEP_ASSURED_ONLY. Cannot change after a REGULAR booking exists or after completion/cancellation. Client cannot supply half-time.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: HalfTimeDecisionResponseDto })
  @ApiConflictResponse({
    description: 'Before half-time, already decided differently, or locked',
  })
  decideHalfTime(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: HalfTimeDecisionDto,
  ) {
    return this.ridesService.decideRegularSeatsPolicy(
      currentUser.userId,
      id,
      body.policy,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a ride by id (owning driver only in this phase)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: RideResponseDto })
  @ApiNotFoundResponse({
    description: 'Ride not found or not owned by the authenticated driver',
  })
  findOne(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ridesService.findOne(currentUser.userId, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an owned ride',
    description:
      'Only the owning driver may update. Regular/COMMUTE PUBLISHED rides: with zero active bookings, route/schedule/fare/seats may change; with active bookings, only seats may change and totalSeats cannot fall below booked seats. ' +
      'COMMUTE series: optional seriesScope=THIS_AND_FUTURE updates this and later same-direction occurrences transactionally; booked occurrences that cannot accept the patch cause 409 without partial updates. THIS_AND_FUTURE cannot change occurrence dates. ' +
      'IN_PROGRESS/COMPLETED/CANCELLED Regular rides cannot be modified. status/driverId/availableSeats cannot be client-controlled. Vehicle changes re-run eligibility checks.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: RideResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation failed, or seats below booked capacity',
  })
  @ApiConflictResponse({
    description:
      'Ride is not editable in its current status, or protected fields changed after bookings',
  })
  @ApiForbiddenResponse({ description: 'Vehicle/driver not eligible' })
  @ApiNotFoundResponse({ description: 'Ride not found' })
  update(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRideDto,
  ) {
    return this.ridesService.update(currentUser.userId, id, body);
  }
}
