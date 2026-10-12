import {
  ConflictException,
  HttpStatus,
  UnprocessableEntityException,
} from '@nestjs/common';

export class RideDepartureInPastError extends UnprocessableEntityException {
  constructor(message = 'Ride departure time must be in the future.') {
    super({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'RIDE_DEPARTURE_IN_PAST',
      message,
      error: 'Unprocessable Entity',
    });
  }
}

export class ActiveAssuredRideExistsError extends ConflictException {
  constructor(
    message = 'You already have an active Assured Ride. Complete or cancel it before publishing another Assured Ride.',
  ) {
    super({
      statusCode: HttpStatus.CONFLICT,
      code: 'ACTIVE_ASSURED_RIDE_EXISTS',
      message,
      error: 'Conflict',
    });
  }
}
