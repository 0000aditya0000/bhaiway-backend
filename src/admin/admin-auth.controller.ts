import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AdminAuthService } from './admin-auth.service';
import { AdminLoginResponseDto } from './dto/admin-login-response.dto';
import { AdminLoginDto } from './dto/admin-login.dto';

@ApiTags('Admin Auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Admin dashboard username/password login',
    description:
      'Returns a BhaiWay JWT usable with /admin/dashboard/* when the account has ADMIN_DASHBOARD_VIEW.',
  })
  @ApiOkResponse({ type: AdminLoginResponseDto })
  @ApiUnauthorizedResponse({ description: 'ADMIN_INVALID_CREDENTIALS' })
  login(@Body() body: AdminLoginDto) {
    return this.adminAuthService.login(body.username, body.password);
  }
}
