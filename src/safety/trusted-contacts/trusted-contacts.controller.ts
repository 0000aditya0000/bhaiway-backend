import {
  Body,
  Controller,
  Delete,
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
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { CreateTrustedContactDto } from './dto/create-trusted-contact.dto';
import {
  TrustedContactListQueryDto,
  TrustedContactPageDto,
  TrustedContactResponseDto,
} from './dto/trusted-contact-response.dto';
import { UpdateTrustedContactDto } from './dto/update-trusted-contact.dto';
import { TrustedContactsService } from './trusted-contacts.service';

@ApiTags('Safety — Trusted Contacts')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('safety/trusted-contacts')
@UseGuards(JwtAuthGuard)
export class TrustedContactsController {
  constructor(private readonly trustedContactsService: TrustedContactsService) {}

  @Post()
  @ApiOperation({ summary: 'Add a trusted contact' })
  @ApiCreatedResponse({ type: TrustedContactResponseDto })
  create(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() body: CreateTrustedContactDto,
  ) {
    return this.trustedContactsService.create(currentUser.userId, body);
  }

  @Get()
  @ApiOperation({ summary: 'List own trusted contacts (newest first)' })
  @ApiOkResponse({ type: TrustedContactPageDto })
  list(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: TrustedContactListQueryDto,
  ) {
    return this.trustedContactsService.list(
      currentUser.userId,
      query.page,
      query.limit,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a trusted contact by id' })
  @ApiOkResponse({ type: TrustedContactResponseDto })
  getById(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.trustedContactsService.getById(currentUser.userId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a trusted contact' })
  @ApiOkResponse({ type: TrustedContactResponseDto })
  update(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTrustedContactDto,
  ) {
    return this.trustedContactsService.update(currentUser.userId, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a trusted contact' })
  @ApiNoContentResponse()
  async remove(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.trustedContactsService.remove(currentUser.userId, id);
  }
}
