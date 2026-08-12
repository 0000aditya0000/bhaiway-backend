import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

export class Msg91InvalidAccessTokenError extends BadRequestException {
  constructor(message = 'MSG91 access token is required') {
    super(message);
  }
}

export class Msg91VerificationFailedError extends UnprocessableEntityException {
  constructor(message = 'MSG91 access token verification failed') {
    super(message);
  }
}

export class Msg91UnavailableError extends ServiceUnavailableException {
  constructor(message = 'MSG91 verification service is unavailable') {
    super(message);
  }
}

/**
 * Thrown when MSG91 returns a successful HTTP/JSON payload whose identity
 * fields cannot be mapped yet because the official response shape is unconfirmed.
 */
export class Msg91ResponseFormatError extends BadGatewayException {
  constructor(
    message = 'MSG91 verifyAccessToken response mapping is pending; verified phone cannot be extracted yet',
  ) {
    super(message);
  }
}
