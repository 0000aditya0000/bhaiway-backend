import {
  ConflictException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

function body(
  statusCode: number,
  code: string,
  message: string,
  error: string,
) {
  return { statusCode, code, message, error };
}

export class CouponNotFoundError extends NotFoundException {
  constructor(message = 'Coupon not found.') {
    super(
      body(HttpStatus.NOT_FOUND, 'COUPON_NOT_FOUND', message, 'Not Found'),
    );
  }
}

export class CouponInactiveError extends UnprocessableEntityException {
  constructor(message = 'This coupon is not active.') {
    super(
      body(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'COUPON_INACTIVE',
        message,
        'Unprocessable Entity',
      ),
    );
  }
}

export class CouponExpiredError extends UnprocessableEntityException {
  constructor(message = 'This coupon has expired.') {
    super(
      body(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'COUPON_EXPIRED',
        message,
        'Unprocessable Entity',
      ),
    );
  }
}

export class CouponNotStartedError extends UnprocessableEntityException {
  constructor(message = 'This coupon is not valid yet.') {
    super(
      body(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'COUPON_NOT_STARTED',
        message,
        'Unprocessable Entity',
      ),
    );
  }
}

export class CouponIneligibleError extends UnprocessableEntityException {
  constructor(message = 'This coupon is not eligible for this charge.') {
    super(
      body(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'COUPON_INELIGIBLE',
        message,
        'Unprocessable Entity',
      ),
    );
  }
}

export class CouponDriversOnlyError extends UnprocessableEntityException {
  constructor(message = 'This coupon is available only for drivers.') {
    super(
      body(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'COUPON_DRIVERS_ONLY',
        message,
        'Unprocessable Entity',
      ),
    );
  }
}

export class CouponRidersOnlyError extends UnprocessableEntityException {
  constructor(message = 'This coupon is available only for riders.') {
    super(
      body(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'COUPON_RIDERS_ONLY',
        message,
        'Unprocessable Entity',
      ),
    );
  }
}

export class CouponExhaustedError extends ConflictException {
  constructor(message = 'This coupon has reached its redemption limit.') {
    super(body(HttpStatus.CONFLICT, 'COUPON_EXHAUSTED', message, 'Conflict'));
  }
}

export class CouponAlreadyUsedError extends ConflictException {
  constructor(message = 'You have already used this coupon.') {
    super(
      body(HttpStatus.CONFLICT, 'COUPON_ALREADY_USED', message, 'Conflict'),
    );
  }
}

export class CouponNotAssignedError extends ForbiddenException {
  constructor(message = 'This coupon is not available for your account.') {
    super(
      body(HttpStatus.FORBIDDEN, 'COUPON_NOT_ASSIGNED', message, 'Forbidden'),
    );
  }
}

export class CouponInvalidConfigError extends UnprocessableEntityException {
  constructor(message = 'Invalid coupon configuration.') {
    super(
      body(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'COUPON_INVALID_CONFIG',
        message,
        'Unprocessable Entity',
      ),
    );
  }
}

export class CouponCodeConflictError extends ConflictException {
  constructor(message = 'A coupon with this code already exists.') {
    super(
      body(HttpStatus.CONFLICT, 'COUPON_CODE_CONFLICT', message, 'Conflict'),
    );
  }
}
