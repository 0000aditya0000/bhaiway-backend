import {
  ConflictException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { DEFAULT_MAX_TRUSTED_CONTACTS } from '../trusted-contact.constants';

export class TrustedContactNotFoundError extends NotFoundException {
  constructor(message = 'Trusted contact not found.') {
    super({
      statusCode: HttpStatus.NOT_FOUND,
      code: 'TRUSTED_CONTACT_NOT_FOUND',
      message,
      error: 'Not Found',
    });
  }
}

export class TrustedContactLimitReachedError extends UnprocessableEntityException {
  constructor(max = DEFAULT_MAX_TRUSTED_CONTACTS) {
    super({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'TRUSTED_CONTACT_LIMIT_REACHED',
      message: `You can add up to ${max} trusted contacts.`,
      error: 'Unprocessable Entity',
    });
  }
}

export class InvalidTrustedContactNameError extends UnprocessableEntityException {
  constructor(message = 'Invalid trusted contact name.') {
    super({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'INVALID_TRUSTED_CONTACT_NAME',
      message,
      error: 'Unprocessable Entity',
    });
  }
}

export class InvalidTrustedContactPhoneError extends UnprocessableEntityException {
  constructor(message = 'Invalid trusted contact phone number.') {
    super({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'INVALID_TRUSTED_CONTACT_PHONE',
      message,
      error: 'Unprocessable Entity',
    });
  }
}

export class InvalidTrustedContactRelationshipError extends UnprocessableEntityException {
  constructor(message = 'Invalid trusted contact relationship.') {
    super({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'INVALID_TRUSTED_CONTACT_RELATIONSHIP',
      message,
      error: 'Unprocessable Entity',
    });
  }
}

export class DuplicateTrustedContactError extends ConflictException {
  constructor(
    message = 'A trusted contact with this phone number already exists.',
  ) {
    super({
      statusCode: HttpStatus.CONFLICT,
      code: 'DUPLICATE_TRUSTED_CONTACT',
      message,
      error: 'Conflict',
    });
  }
}
