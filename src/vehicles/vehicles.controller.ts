import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
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
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { VehicleResponseDto } from './dto/vehicle-response.dto';
import { VehiclesService } from './vehicles.service';

@ApiTags('Vehicles')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('vehicles')
@UseGuards(JwtAuthGuard)
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a vehicle',
    description:
      'Creates a vehicle for the authenticated user. userId and verification fields are never client-controlled. First vehicle is auto-activated.',
  })
  @ApiCreatedResponse({ type: VehicleResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiConflictResponse({
    description: 'Duplicate registration number for this user',
  })
  create(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: CreateVehicleDto,
  ) {
    return this.vehiclesService.create(currentUser.userId, body);
  }

  @Get()
  @ApiOperation({ summary: 'List vehicles for the authenticated user' })
  @ApiOkResponse({ type: VehicleResponseDto, isArray: true })
  findAll(@CurrentUser() currentUser: AuthenticatedUser) {
    return this.vehiclesService.findAll(currentUser.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a vehicle by id (owner only)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: VehicleResponseDto })
  @ApiNotFoundResponse({
    description: 'Vehicle not found or not owned by the authenticated user',
  })
  findOne(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.vehiclesService.findOne(currentUser.userId, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a vehicle (owner only)',
    description:
      'Partial update. Cannot set isActive, userId, or verification fields. Material identity changes invalidate current VEHICLE verification.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: VehicleResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiNotFoundResponse({ description: 'Vehicle not found' })
  @ApiConflictResponse({
    description: 'Duplicate registration number for this user',
  })
  update(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateVehicleDto,
  ) {
    return this.vehiclesService.update(currentUser.userId, id, body);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Soft-delete a vehicle (owner only)',
    description: 'Marks the vehicle deleted for future ride history preservation.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: VehicleResponseDto })
  @ApiNotFoundResponse({ description: 'Vehicle not found' })
  remove(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.vehiclesService.remove(currentUser.userId, id);
  }

  @Post(':id/activate')
  @ApiOperation({
    summary: 'Set the active/preferred vehicle',
    description:
      'Activates the selected vehicle and deactivates other vehicles for the authenticated user. isActive cannot be changed via PATCH.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: VehicleResponseDto })
  @ApiNotFoundResponse({ description: 'Vehicle not found' })
  activate(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.vehiclesService.setActiveVehicle(currentUser.userId, id);
  }
}
