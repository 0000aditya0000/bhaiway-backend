import { ConflictException } from '@nestjs/common';

export class PhoneAlreadyRegisteredError extends ConflictException {
  constructor(message = 'Number already registered. Please login.') {
    super({
      statusCode: 409,
      code: 'PHONE_ALREADY_REGISTERED',
      message,
      error: 'Conflict',
    });
  }
}
