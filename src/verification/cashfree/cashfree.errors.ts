import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

export class CashfreeApiError extends BadGatewayException {
  constructor(message = 'Upstream verification service error') {
    super({
      statusCode: 502,
      code: 'CASHFREE_UPSTREAM_ERROR',
      message,
      error: 'Bad Gateway',
    });
  }
}

export class CashfreeWebhookSignatureError extends UnauthorizedException {
  constructor(message = 'Invalid Cashfree webhook signature') {
    super({
      statusCode: 401,
      code: 'INVALID_WEBHOOK_SIGNATURE',
      message,
      error: 'Unauthorized',
    });
  }
}

export class CashfreeWebhookTimestampError extends BadRequestException {
  constructor(message = 'Webhook timestamp is expired or outside the valid replay window') {
    super({
      statusCode: 400,
      code: 'EXPIRED_WEBHOOK_TIMESTAMP',
      message,
      error: 'Bad Request',
    });
  }
}

export class KycAlreadyVerifiedError extends ConflictException {
  constructor(message = 'User identity is already verified') {
    super({
      statusCode: 409,
      code: 'KYC_ALREADY_VERIFIED',
      message,
      error: 'Conflict',
    });
  }
}

export class KycVerificationNotFoundError extends NotFoundException {
  constructor(message = 'Verification session not found') {
    super({
      statusCode: 404,
      code: 'KYC_VERIFICATION_NOT_FOUND',
      message,
      error: 'Not Found',
    });
  }
}

export class KycForbiddenError extends ForbiddenException {
  constructor(message = 'You do not have access to this verification record') {
    super({
      statusCode: 403,
      code: 'KYC_ACCESS_DENIED',
      message,
      error: 'Forbidden',
    });
  }
}
