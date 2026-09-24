import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';

export class EmailAlreadyVerifiedError extends ConflictException {
  constructor(message = 'This email address is already verified') {
    super({
      statusCode: 409,
      code: 'EMAIL_ALREADY_VERIFIED',
      message,
      error: 'Conflict',
    });
  }
}

export class EmailVerificationNotFoundError extends NotFoundException {
  constructor(message = 'No active email verification code was found') {
    super({
      statusCode: 404,
      code: 'EMAIL_VERIFICATION_NOT_FOUND',
      message,
      error: 'Not Found',
    });
  }
}

export class EmailVerificationExpiredError extends BadRequestException {
  constructor(message = 'The verification code has expired') {
    super({
      statusCode: 400,
      code: 'EMAIL_VERIFICATION_EXPIRED',
      message,
      error: 'Bad Request',
    });
  }
}

export class EmailVerificationInvalidError extends BadRequestException {
  constructor(message = 'The verification code is invalid') {
    super({
      statusCode: 400,
      code: 'EMAIL_VERIFICATION_INVALID',
      message,
      error: 'Bad Request',
    });
  }
}

export class EmailVerificationAttemptsExceededError extends HttpException {
  constructor(
    message = 'Too many incorrect verification attempts. Request a new code.',
  ) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'EMAIL_VERIFICATION_ATTEMPTS_EXCEEDED',
        message,
        error: 'Too Many Requests',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class EmailVerificationRateLimitedError extends HttpException {
  constructor(
    message = 'Too many verification emails were requested. Try again later.',
  ) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'EMAIL_VERIFICATION_RATE_LIMITED',
        message,
        error: 'Too Many Requests',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class EmailVerificationCooldownError extends HttpException {
  constructor(
    message = 'Please wait before requesting another verification code.',
  ) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'EMAIL_VERIFICATION_COOLDOWN',
        message,
        error: 'Too Many Requests',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class EmailMismatchError extends ForbiddenException {
  constructor(
    message = 'The email address does not match the address on your account',
  ) {
    super({
      statusCode: 403,
      code: 'EMAIL_MISMATCH',
      message,
      error: 'Forbidden',
    });
  }
}

export class EmailSendFailedError extends BadGatewayException {
  constructor(message = 'Unable to send the verification email') {
    super({
      statusCode: 502,
      code: 'EMAIL_SEND_FAILED',
      message,
      error: 'Bad Gateway',
    });
  }
}
