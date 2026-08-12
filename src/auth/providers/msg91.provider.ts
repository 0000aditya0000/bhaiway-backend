import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  Msg91InvalidAccessTokenError,
  Msg91ResponseFormatError,
  Msg91UnavailableError,
  Msg91VerificationFailedError,
} from '../errors/msg91.errors';
import { OtpProvider, VerifiedOtpUser } from './otp-provider.interface';

const MSG91_VERIFY_ACCESS_TOKEN_URL =
  'https://api.msg91.com/api/v5/widget/verifyAccessToken';

interface Msg91VerifyAccessTokenResponse {
  type?: unknown;
  message?: unknown;
}

@Injectable()
export class Msg91OtpProvider implements OtpProvider {
  constructor(private readonly configService: ConfigService) {}

  async verifyAccessToken(accessToken: string): Promise<VerifiedOtpUser> {
    const trimmedToken = accessToken?.trim();
    if (!trimmedToken) {
      throw new Msg91InvalidAccessTokenError();
    }

    const authkey = this.configService.get<string>('MSG91_AUTHKEY')?.trim();
    if (!authkey) {
      throw new Msg91UnavailableError('MSG91_AUTHKEY is not configured');
    }

    let response: Response;
    try {
      response = await fetch(MSG91_VERIFY_ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: {
          authkey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          'access-token': trimmedToken,
        }),
      });
    } catch {
      // Do not log access token or authkey.
      throw new Msg91UnavailableError('Failed to reach MSG91 verification API');
    }

    if (!response.ok) {
      throw new Msg91VerificationFailedError(
        `MSG91 verification rejected with HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Msg91ResponseFormatError(
        'MSG91 verifyAccessToken returned a non-JSON body',
      );
    }

    if (payload === null || typeof payload !== 'object') {
      throw new Msg91ResponseFormatError(
        'MSG91 verifyAccessToken returned a non-object JSON payload',
      );
    }

    const body = payload as Msg91VerifyAccessTokenResponse;

    if (body.type !== 'success') {
      throw new Msg91VerificationFailedError(
        'MSG91 access token verification was not successful',
      );
    }

    if (typeof body.message !== 'string' || !body.message.trim()) {
      throw new Msg91ResponseFormatError(
        'MSG91 success response did not include a verified phone in message',
      );
    }

    const verifiedPhone = body.message.replace(/\s+/g, '').trim();

    return {
      phone: verifiedPhone,
      verified: true,
    };
  }
}
