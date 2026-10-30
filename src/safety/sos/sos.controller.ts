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
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { PublishSosLocationDto, TriggerSosDto } from './dto/trigger-sos.dto';
import { SosService } from './sos.service';

@ApiTags('SOS')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('rides')
@UseGuards(JwtAuthGuard)
export class SosController {
  constructor(private readonly sosService: SosService) {}

  @Post(':rideId/sos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger SOS for an in-progress ride',
    description:
      'Driver or confirmed passenger only. Additional triggers attach to the existing active SOS.',
  })
  @ApiOkResponse({ description: 'SOS created or additional trigger attached' })
  @ApiNotFoundResponse({ description: 'Ride not found for this participant' })
  @ApiConflictResponse({ description: 'Ride is not IN_PROGRESS' })
  trigger(
    @CurrentUser() user: AuthenticatedUser,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body() body: TriggerSosDto,
  ) {
    return this.sosService.trigger(user.userId, rideId, body ?? {});
  }

  @Get(':rideId/sos')
  @ApiOperation({
    summary: 'Get the active SOS for a ride (participants only)',
  })
  getActive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('rideId', ParseUUIDPipe) rideId: string,
  ) {
    return this.sosService.getActiveForParticipant(user.userId, rideId);
  }

  @Post(':rideId/sos/location')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish participant location during an active SOS',
  })
  publishLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body() body: PublishSosLocationDto,
  ) {
    return this.sosService.publishLocation(user.userId, rideId, body);
  }
}
