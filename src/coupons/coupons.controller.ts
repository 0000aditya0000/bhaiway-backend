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
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  CouponListQueryDto,
  DriverPreviewCouponDto,
  PreviewCouponDto,
  ValidateCouponDto,
} from './dto/user-coupon-api.dto';
import { CouponsService } from './coupons.service';

@ApiTags('Coupons')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('coupons')
@UseGuards(JwtAuthGuard)
export class CouponsController {
  constructor(private readonly couponsService: CouponsService) {}

  @Get('public')
  @ApiOperation({ summary: 'List public coupons available to the current user' })
  listPublic(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CouponListQueryDto,
  ) {
    return this.couponsService.listPublicForUser(
      user.userId,
      query.page,
      query.limit,
    );
  }

  @Get('mine')
  @ApiOperation({
    summary: 'List user-specific coupons assigned to the current user',
  })
  listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CouponListQueryDto,
  ) {
    return this.couponsService.listAssignedForUser(
      user.userId,
      query.page,
      query.limit,
    );
  }

  @Get('redemptions')
  @ApiOperation({ summary: 'Current user coupon redemption history' })
  listRedemptions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CouponListQueryDto,
  ) {
    return this.couponsService.listRedemptionsForUser(
      user.userId,
      query.page,
      query.limit,
    );
  }

  @Get('issuances')
  @ApiOperation({ summary: 'Current user issued-coupon history' })
  listIssuances(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CouponListQueryDto,
  ) {
    return this.couponsService.listIssuancesForUser(
      user.userId,
      query.page,
      query.limit,
    );
  }

  @Get('driver/public')
  @ApiOperation({
    summary:
      'List public coupons available for the authenticated driver (ALL and DRIVERS_ONLY Assured deposit coupons)',
  })
  listDriverPublic(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CouponListQueryDto,
  ) {
    return this.couponsService.listPublicForDriver(
      user.userId,
      query.page,
      query.limit,
    );
  }

  @Get('driver/mine')
  @ApiOperation({
    summary:
      'List user-specific coupons assigned to the authenticated driver for Assured deposit redemption',
  })
  listDriverMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CouponListQueryDto,
  ) {
    return this.couponsService.listAssignedForDriver(
      user.userId,
      query.page,
      query.limit,
    );
  }

  @Post('driver/validate')
  @ApiOperation({
    summary:
      'Validate a driver coupon against the server-calculated Assured deposit (no capacity consumed)',
  })
  validateDriver(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DriverPreviewCouponDto,
  ) {
    return this.couponsService.previewForDriver(user.userId, body);
  }

  @Post('driver/preview')
  @ApiOperation({
    summary:
      'Preview a driver coupon against the server-calculated Assured deposit (no capacity consumed)',
  })
  previewDriver(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DriverPreviewCouponDto,
  ) {
    return this.couponsService.previewForDriver(user.userId, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get coupon details if visible to the current user' })
  @ApiOkResponse({ description: 'Coupon detail' })
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.couponsService.getForUser(user.userId, id);
  }

  @Post('validate')
  @ApiOperation({
    summary: 'Validate a coupon code for ride type and charge scope (no capacity consumed)',
  })
  validate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ValidateCouponDto,
  ) {
    return this.couponsService.validateForUser(user.userId, body);
  }

  @Post('preview')
  @ApiOperation({
    summary: 'Preview coupon benefit for an amount (no capacity consumed)',
  })
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PreviewCouponDto,
  ) {
    return this.couponsService.previewForUser(user.userId, body);
  }
}
