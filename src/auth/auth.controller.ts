import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { AuthService } from './auth.service';
import { AuthLoginResponseDto } from './dto/auth-response.dto';
import { DevLoginDto } from './dto/dev-login.dto';
import { VerifyMsg91Dto } from './dto/verify-msg91.dto';
import { Msg91InvalidAccessTokenError } from './errors/msg91.errors';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Accepts MSG91 widget access-token, verifies with MSG91, then issues BhaiWay JWT.
   * Verified phone comes only from MSG91 response.message.
   */
  @Post('msg91/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify MSG91 access token and issue BhaiWay JWT',
    description:
      'Validates the MSG91 Widget access-token server-side. Verified phone is taken only from the MSG91 provider response — never from the client body.',
  })
  @ApiOkResponse({
    description: 'Authentication successful',
    type: AuthLoginResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Missing/invalid access token or MSG91 verification failure',
  })
  @ApiUnauthorizedResponse({
    description: 'MSG91 rejected the access token',
  })
  async verifyMsg91(@Body() body: VerifyMsg91Dto) {
    if (!body?.accessToken || typeof body.accessToken !== 'string') {
      throw new Msg91InvalidAccessTokenError();
    }

    return this.authService.verifyMsg91AccessToken(body.accessToken);
  }

  /**
   * Development-only login.
   * Requires NODE_ENV !== 'production' and DEV_AUTH_ENABLED=true.
   * Always authenticates DEV_AUTH_PHONE from configuration (request phone is ignored).
   */
  @Post('dev/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Development-only login (disabled in production)',
    description:
      'DEVELOPMENT ONLY. Requires NODE_ENV !== production and DEV_AUTH_ENABLED=true. Always authenticates the configured DEV_AUTH_PHONE. Does not accept client-supplied credentials.',
  })
  @ApiOkResponse({
    description: 'Development authentication successful',
    type: AuthLoginResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Dev auth disabled or running in production',
  })
  async devLogin(@Body() _body: DevLoginDto) {
    return this.authService.devLogin();
  }
}
