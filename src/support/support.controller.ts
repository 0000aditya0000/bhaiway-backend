import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { AddSupportCommentDto } from './dto/add-support-comment.dto';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';
import { EligibleRidesQueryDto } from './dto/eligible-rides-query.dto';
import {
  EligibleSupportRidePageDto,
  SupportCommentDto,
  SupportTicketDetailDto,
  SupportTicketPageDto,
} from './dto/support-ticket-response.dto';
import { SupportTicketListQueryDto } from './dto/support-ticket-query.dto';
import { SupportService } from './support.service';

@ApiTags('Support')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
@Controller('support')
@UseGuards(JwtAuthGuard)
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Get('eligible-rides')
  @ApiOperation({
    summary:
      'List rides/bookings eligible for a Bookings & Rides support ticket',
    description:
      'Returns active or past rides where the JWT subject is the driver or an associated passenger. Ownership is derived from authentication.',
  })
  @ApiOkResponse({ type: EligibleSupportRidePageDto })
  @ApiBadRequestResponse({ description: 'Invalid query' })
  listEligibleRides(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: EligibleRidesQueryDto,
  ) {
    return this.supportService.listEligibleRides(user.userId, query);
  }

  @Post('tickets')
  @ApiOperation({ summary: 'Create a help & support ticket' })
  @ApiCreatedResponse({ type: SupportTicketDetailDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiForbiddenResponse({ description: 'Ride not owned by user' })
  @ApiUnprocessableEntityResponse({
    description: 'Ride/transaction ineligible',
  })
  createTicket(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateSupportTicketDto,
  ) {
    return this.supportService.createTicket(user.userId, body);
  }

  @Get('tickets')
  @ApiOperation({ summary: 'List the authenticated user’s support tickets' })
  @ApiOkResponse({ type: SupportTicketPageDto })
  listTickets(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SupportTicketListQueryDto,
  ) {
    return this.supportService.listTicketsForUser(user.userId, query);
  }

  @Get('tickets/:ticketId')
  @ApiOperation({ summary: 'Get support ticket detail for the ticket owner' })
  @ApiOkResponse({ type: SupportTicketDetailDto })
  @ApiNotFoundResponse({ description: 'SUPPORT_TICKET_NOT_FOUND' })
  getTicket(
    @CurrentUser() user: AuthenticatedUser,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
  ) {
    return this.supportService.getTicketForUser(user.userId, ticketId);
  }

  @Post('tickets/:ticketId/comments')
  @ApiOperation({
    summary: 'Add a user comment on an open support ticket',
    description:
      'Author is always the authenticated user. Resolved tickets reject new comments.',
  })
  @ApiCreatedResponse({ type: SupportCommentDto })
  @ApiNotFoundResponse({ description: 'SUPPORT_TICKET_NOT_FOUND' })
  addComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() body: AddSupportCommentDto,
  ) {
    return this.supportService.addUserComment(user.userId, ticketId, body);
  }
}
