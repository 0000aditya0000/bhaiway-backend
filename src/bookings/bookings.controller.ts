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
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { AssuredBookingLifecycleResponseDto } from '../assured/dto/assured-lifecycle-response.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { BookingResponseDto } from './dto/booking-response.dto';
import { CreateBookingDto } from './dto/create-booking.dto';
import { BookingHistoryQueryDto } from './dto/booking-history-query.dto';
import {
  BookingHistoryDetailDto,
  BookingHistoryPageDto,
} from './dto/booking-history-response.dto';
import { DriverBookingsQueryDto } from './dto/driver-bookings-query.dto';
import { DriverBookingPageDto } from './dto/driver-booking-response.dto';
import { VerifyPickupDto } from './dto/verify-pickup.dto';
import { VerifyPickupResponseDto } from './dto/verify-pickup-response.dto';
import { BookingsService } from './bookings.service';

@ApiTags('Bookings')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a booking (PAY_LATER, PAY_NOW, or ASSURED_DEPOSIT)',
    description:
      'REGULAR rides: PAY_NOW or PAY_LATER (farePayment must be omitted). ' +
      'ASSURED rides with paymentMethod=ASSURED_DEPOSIT: mandatory security-deposit wallet HOLD; ' +
      'optional farePayment=PAY_NOW|PAY_LATER (defaults to PAY_LATER when omitted). ' +
      'ASSURED_DEPOSIT + PAY_LATER → deposit held, fare UNPAID. ' +
      'ASSURED_DEPOSIT + PAY_NOW → deposit held and fare debited atomically (fare PAID). ' +
      'Assured rides cannot use PAY_NOW/PAY_LATER without deposit unless the driver has opened remaining seats (ALLOW_REGULAR_RIDERS). ' +
      'Insufficient balance returns 422. Idempotency-Key is required for PAY_NOW and ASSURED_DEPOSIT.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Required for PAY_NOW and ASSURED_DEPOSIT. Reused safely on retries. Changing farePayment with the same key is rejected.',
  })
  @ApiCreatedResponse({ type: BookingResponseDto })
  @ApiBadRequestResponse({
    description:
      'Validation failed, ride not published, missing Idempotency-Key, invalid payment method, or farePayment used without ASSURED_DEPOSIT',
  })
  @ApiForbiddenResponse({
    description:
      'Identity not verified, driver booking own ride, or wallet suspended/locked',
  })
  @ApiNotFoundResponse({ description: 'Ride or wallet not found' })
  @ApiConflictResponse({
    description:
      'Insufficient seats, duplicate active booking, Regular booking blocked before ALLOW_REGULAR_RIDERS, or idempotency key reused with a different payload',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Insufficient wallet balance (deposit only for PAY_LATER; deposit + fare for PAY_NOW)',
  })
  create(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: CreateBookingDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.bookingsService.create(currentUser.userId, body, {
      idempotencyKey,
    });
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel own booking (passenger only)',
    description:
      'Assured-mode before departure: consume rider deposit (100% platform), restore seats, optional platform-funded partial-fill under KEEP_ASSURED_ONLY. Regular-mode: restore seats only. After departure use no-show. Drivers cannot use this endpoint.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AssuredBookingLifecycleResponseDto })
  @ApiNotFoundResponse({
    description: 'Booking not found for this passenger',
  })
  @ApiConflictResponse({ description: 'Invalid timing or state' })
  cancel(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingsService.cancelByPassenger(currentUser.userId, id);
  }

  @Post(':id/rider-no-show')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Report rider no-show (ride owning driver only)',
    description:
      'At/after departure for a CONFIRMED Assured-mode booking. Consumes rider deposit (100% platform), issues NEXT_ASSURED_DEPOSIT_FREE, restores seats, optional partial-fill. Passengers cannot report themselves. Idempotent.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AssuredBookingLifecycleResponseDto })
  @ApiNotFoundResponse({
    description: 'Booking not found for this driver',
  })
  @ApiConflictResponse({ description: 'Before departure or invalid state' })
  reportRiderNoShow(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingsService.reportRiderNoShow(currentUser.userId, id);
  }

  @Post(':id/verify-pickup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify passenger pickup OTP (owning driver only)',
    description:
      'REGULAR and ASSURED trip-lifecycle rides. Ride must be IN_PROGRESS. Booking must be CONFIRMED and WAITING_FOR_PICKUP. Marks booking PICKED_UP on success. Idempotent when already picked up. Never returns the OTP.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Booking id' })
  @ApiOkResponse({ type: VerifyPickupResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid OTP format or wrong OTP' })
  @ApiNotFoundResponse({
    description: 'Booking not found for this driver',
  })
  @ApiConflictResponse({
    description: 'Ride not in progress, cancelled booking, locked OTP, etc.',
  })
  verifyPickup(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VerifyPickupDto,
  ) {
    return this.bookingsService.verifyPickup(currentUser.userId, id, body);
  }

  @Get('my')
  @ApiOperation({
    summary: 'List bookings for the authenticated passenger',
  })
  @ApiOkResponse({ type: BookingResponseDto, isArray: true })
  findMine(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.bookingsService.findMine(currentUser.userId);
  }

  @Get('driver/my-rides')
  @ApiOperation({
    summary: 'List bookings for rides owned by the authenticated driver',
    description:
      'Returns paginated bookings where ride.driverId matches the JWT subject only. Optional rideId/status filters. When rideId is set, results are ordered by pickupOrder ASC for sequential boarding. Includes pickupStatus (never OTP). Read-only: never mutates wallets, holds, seats, or booking state. Client-supplied driverId/userId are rejected.',
  })
  @ApiOkResponse({ type: DriverBookingPageDto })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters (page, limit, status, rideId)',
  })
  @ApiNotFoundResponse({
    description:
      'rideId was supplied but no matching ride exists for this driver',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
  findDriverRideBookings(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: DriverBookingsQueryDto,
  ) {
    return this.bookingsService.findForDriverRides(currentUser.userId, query);
  }

  @Get('history')
  @ApiOperation({
    summary: 'Paginated past bookings for the authenticated passenger',
    description:
      'Returns COMPLETED and CANCELLED bookings owned by the JWT subject only. Active PENDING/CONFIRMED bookings are excluded. Fare/driver/vehicle come from real database records; unavailable invoice/coords fields are null.',
  })
  @ApiOkResponse({ type: BookingHistoryPageDto })
  @ApiBadRequestResponse({ description: 'Invalid query parameters' })
  findHistory(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: BookingHistoryQueryDto,
  ) {
    return this.bookingsService.findHistory(currentUser.userId, query);
  }

  @Get('history/:id')
  @ApiOperation({
    summary: 'Past booking detail for the booking owner',
    description:
      'Includes driver, vehicle, fare breakdown, and payment fields from real data. Invoice IDs are null until an invoice system exists.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: BookingHistoryDetailDto })
  @ApiNotFoundResponse({
    description: 'Past booking not found for this passenger',
  })
  findHistoryDetail(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingsService.findHistoryDetail(currentUser.userId, id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a booking by id (booking owner only)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: BookingResponseDto })
  @ApiNotFoundResponse({
    description: 'Booking not found or not owned by the authenticated passenger',
  })
  findOne(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingsService.findOne(currentUser.userId, id);
  }
}
