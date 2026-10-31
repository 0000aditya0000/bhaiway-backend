import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

export class EmailSameAsCurrentError extends BadRequestException {
  constructor(message = 'New email cannot be the same as your current email') {
    super({
      statusCode: 400,
      code: 'EMAIL_SAME_AS_CURRENT',
      message,
      error: 'Bad Request',
    });
  }
}

export class EmailAlreadyRegisteredError extends ConflictException {
  constructor(
    message = 'This email address is already registered to another account',
  ) {
    super({
      statusCode: 409,
      code: 'EMAIL_ALREADY_REGISTERED',
      message,
      error: 'Conflict',
    });
  }
}

export class NoPendingEmailChangeError extends NotFoundException {
  constructor(message = 'No pending email change request was found') {
    super({
      statusCode: 404,
      code: 'NO_PENDING_EMAIL_CHANGE',
      message,
      error: 'Not Found',
    });
  }
}

export class PendingEmailMismatchError extends BadRequestException {
  constructor(
    message = 'The submitted email does not match your pending email change request',
  ) {
    super({
      statusCode: 400,
      code: 'PENDING_EMAIL_MISMATCH',
      message,
      error: 'Bad Request',
    });
  }
}
