import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

export class SosNotFoundError extends NotFoundException {
  constructor(message = 'SOS not found') {
    super({
      statusCode: 404,
      code: 'SOS_NOT_FOUND',
      message,
      error: 'Not Found',
    });
  }
}

export class SosRideNotFoundError extends NotFoundException {
  constructor() {
    super({
      statusCode: 404,
      code: 'SOS_RIDE_NOT_FOUND',
      message: 'Ride not found',
      error: 'Not Found',
    });
  }
}

export class SosRideNotEligibleError extends ConflictException {
  constructor(
    message = 'SOS can only be triggered during an in-progress ride',
  ) {
    super({
      statusCode: 409,
      code: 'SOS_RIDE_NOT_ELIGIBLE',
      message,
      error: 'Conflict',
    });
  }
}

export class SosInvalidTransitionError extends ConflictException {
  constructor(message = 'Invalid SOS status transition') {
    super({
      statusCode: 409,
      code: 'SOS_INVALID_TRANSITION',
      message,
      error: 'Conflict',
    });
  }
}

export class SosReasonRequiredError extends UnprocessableEntityException {
  constructor(message = 'A reason is required') {
    super({
      statusCode: 422,
      code: 'SOS_REASON_REQUIRED',
      message,
      error: 'Unprocessable Entity',
    });
  }
}

export class SosAccessDeniedError extends ForbiddenException {
  constructor(message = 'SOS access denied') {
    super({
      statusCode: 403,
      code: 'SOS_ACCESS_DENIED',
      message,
      error: 'Forbidden',
    });
  }
}
