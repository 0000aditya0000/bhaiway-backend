import {
  ConflictException,
  HttpException,
  HttpStatus,
  UnprocessableEntityException,
} from '@nestjs/common';

export class ReferralCodeInvalidError extends UnprocessableEntityException {
  constructor(message = 'Invalid referral code.') {
    super({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'REFERRAL_CODE_INVALID',
      message,
      error: 'Unprocessable Entity',
    });
  }
}

export class SelfReferralNotAllowedError extends UnprocessableEntityException {
  constructor(message = 'You cannot use your own referral code.') {
    super({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'SELF_REFERRAL_NOT_ALLOWED',
      message,
      error: 'Unprocessable Entity',
    });
  }
}

export class ReferralAlreadyExistsError extends ConflictException {
  constructor(message = 'This account already has a referral relationship.') {
    super({
      statusCode: HttpStatus.CONFLICT,
      code: 'REFERRAL_ALREADY_EXISTS',
      message,
      error: 'Conflict',
    });
  }
}

export class ReferralCodeGenerationError extends HttpException {
  constructor(message = 'Unable to allocate a unique referral code') {
    super(
      {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'REFERRAL_CODE_GENERATION_FAILED',
        message,
        error: 'Internal Server Error',
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
