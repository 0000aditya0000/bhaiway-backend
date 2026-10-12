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
import {
  SendMsg91OtpDto,
  SendMsg91OtpResponseDto,
} from './dto/send-msg91-otp.dto';
import { VerifyMsg91Dto } from './dto/verify-msg91.dto';
import { Msg91InvalidAccessTokenError } from './errors/msg91.errors';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Accepts MSG91 widget access-token, verifies with MSG91, then issues BhaiWay JWT.
   * Verified phone comes only from MSG91 response.message.
   *
   * Play Store review (when PLAY_REVIEW_LOGIN_ENABLED=true):
   * accept phone + otp matching configured env values and issue the same JWT response.
   */
  @Post('msg91/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify MSG91 access token (or Play review credentials) and issue BhaiWay JWT',
    description:
      'Normal path: validates the MSG91 Widget access-token server-side. Verified phone is taken only from the MSG91 provider response. ' +
      'Play Store review path (env-gated): accepts phone + OTP only when PLAY_REVIEW_LOGIN_ENABLED=true and both match server configuration. ' +
      'Response shape is identical for both paths.',
  })
  @ApiOkResponse({
    description: 'Authentication successful',
    type: AuthLoginResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Missing/invalid access token or MSG91 verification failure',
  })
  @ApiUnauthorizedResponse({
    description: 'MSG91 rejected the access token or review credentials are invalid',
  })
  async verifyMsg91(@Body() body: VerifyMsg91Dto) {
    const accessToken =
      typeof body?.accessToken === 'string' ? body.accessToken : undefined;
    const phone = typeof body?.phone === 'string' ? body.phone : undefined;
    const otp = typeof body?.otp === 'string' ? body.otp : undefined;
    const referralCode =
      typeof body?.referralCode === 'string' ? body.referralCode : undefined;

    if (!accessToken?.trim() && !(phone?.trim() && otp?.trim())) {
      throw new Msg91InvalidAccessTokenError();
    }

    return this.authService.verifyMsg91({
      accessToken,
      phone,
      otp,
      referralCode,
    });
  }

  /**
   * OTP send acknowledgement for client compatibility.
   * Review phone (when enabled) does not trigger MSG91 SMS.
   * Never returns the OTP value.
   */
  @Post('msg91/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acknowledge OTP send (MSG91 Widget remains primary delivery)',
    description:
      'For the configured Play Store review phone when PLAY_REVIEW_LOGIN_ENABLED=true, returns success without sending SMS. ' +
      'For all other phones, returns a generic acknowledgement — the MSG91 Widget on the client owns real SMS delivery. Never returns OTP.',
  })
  @ApiOkResponse({ type: SendMsg91OtpResponseDto })
  @ApiBadRequestResponse({ description: 'Missing phone' })
  async sendMsg91Otp(@Body() body: SendMsg91OtpDto) {
    return this.authService.sendMsg91Otp(body.phone);
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
