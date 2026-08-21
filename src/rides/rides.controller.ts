import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
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
import { CompleteRideResponseDto } from './dto/complete-ride-response.dto';
import { CreateRideDto } from './dto/create-ride.dto';
import { RideResponseDto } from './dto/ride-response.dto';
import {
  RideSearchItemDto,
  RideSearchPageDto,
} from './dto/ride-search-response.dto';
import { SearchRidesDto } from './dto/search-rides.dto';
import { UpdateRideDto } from './dto/update-ride.dto';
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
      'Creates a PUBLISHED REGULAR or ASSURED ride after verification checks. ASSURED publishing atomically creates an ACTIVE driver ASSURED_DEPOSIT wallet hold (ledger ASSURED_DEPOSIT_HOLD) based on totalPublishedSeats × pricePerSeat × admin deposit %. driverId/status/availableSeats are server-controlled.',
  })
  @ApiCreatedResponse({ type: RideResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiForbiddenResponse({
    description: 'Driver or vehicle is not eligible to publish',
  })
  create(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: CreateRideDto,
  ) {
    return this.ridesService.create(currentUser.userId, body);
  }

  @Get('search')
  @ApiOperation({
    summary: 'Search published rides (passenger discovery)',
    description:
      'Read-only search of PUBLISHED rides. Optional rideType filters REGULAR or ASSURED; when omitted, both types are returned. Filters by source/destination (case-insensitive contains), date, optional time (at/after), and seats. Paginated.',
  })
  @ApiOkResponse({ type: RideSearchPageDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  search(@Query() query: SearchRidesDto) {
    return this.ridesService.search(query);
  }

  @Get('my')
  @ApiOperation({
    summary: 'List rides created by the authenticated driver',
  })
  @ApiOkResponse({ type: RideResponseDto, isArray: true })
  findMine(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.ridesService.findMine(currentUser.userId);
  }

  @Get('public/:id')
  @ApiOperation({
    summary: 'Passenger-facing published ride detail',
    description:
      'Returns safe public fields for a PUBLISHED REGULAR or ASSURED ride. Does not change owner-only GET /rides/:id behavior. Does not expose phones, emails, wallet, or verification documents.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: RideSearchItemDto })
  @ApiNotFoundResponse({
    description: 'Published ride not found',
  })
  findPublishedPublic(@Param('id', ParseUUIDPipe) id: string) {
    return this.ridesService.findPublishedPublic(id);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a published ride (owning driver only)',
    description:
      'Transitions PUBLISHED → COMPLETED. For ASSURED rides, releases ACTIVE driver and eligible rider ASSURED_DEPOSIT holds (HOLD_RELEASE / CREDIT) atomically and marks eligible bookings COMPLETED. May pay platform-funded partial-fill compensation when KEEP_ASSURED_ONLY leaves empty seats. Regular rides complete without deposit release. Safe to retry when already COMPLETED. Cancelled/draft rides return 409. Status cannot be set via PATCH.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CompleteRideResponseDto })
  @ApiNotFoundResponse({
    description: 'Ride not found or not owned by the authenticated driver',
  })
  @ApiConflictResponse({
    description: 'Ride is DRAFT/CANCELLED or a deposit hold cannot be released',
  })
  complete(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ridesService.complete(currentUser.userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a published ride (owning driver only)',
    description:
      'REGULAR: cancels the ride and all active passenger bookings (RIDE_CANCELLED). No wallet deposit/refund processing. ASSURED: before scheduled departure consumes driver ASSURED_DEPOSIT, releases affected rider deposits, distributes 60/40 compensation, cancels bookings. Idempotent when already cancelled with the same reason. Status cannot be set via PATCH.',
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
  ) {
    return this.ridesService.cancelByDriver(currentUser.userId, id);
  }

  @Post(':id/driver-no-show')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Report driver no-show (affected Assured passenger)',
    description:
      'Callable only by a passenger with an active Assured booking on the ride, and only at/after scheduled departure. Financially identical to driver cancellation (deposit consume, 60/40 split, rider deposit release). No GPS verification. Idempotent. Drivers cannot mark themselves no-show via this endpoint.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AssuredRideLifecycleResponseDto })
  @ApiNotFoundResponse({
    description: 'Ride not found for this reporter',
  })
  @ApiConflictResponse({
    description: 'Before departure, already completed/cancelled, or duplicate',
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
      'Only the owning driver may update. status/driverId/availableSeats cannot be client-controlled. Use POST /rides/:id/complete to complete a ride. Vehicle changes re-run eligibility checks.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: RideResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
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
