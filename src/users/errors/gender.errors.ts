import { ForbiddenException } from '@nestjs/common';

export class GenderLockedError extends ForbiddenException {
  constructor(
    message = 'Gender is determined from Aadhaar verification and cannot be changed manually.',
  ) {
    super({
      statusCode: 403,
      code: 'GENDER_LOCKED',
      message,
      error: 'Forbidden',
    });
  }
}

export class WomenOnlyRideError extends ForbiddenException {
  constructor(
    message = 'This ride is Women Only. Only verified female riders can book this ride.',
  ) {
    super({
      statusCode: 403,
      code: 'WOMEN_ONLY_RIDE',
      message,
      error: 'Forbidden',
    });
  }
}
