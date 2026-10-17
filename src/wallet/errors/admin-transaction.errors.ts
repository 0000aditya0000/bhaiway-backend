import {
  ConflictException,
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

export class AdminTransactionNotFoundError extends NotFoundException {
  constructor(message = 'Transaction not found.') {
    super(
      body(
        HttpStatus.NOT_FOUND,
        'ADMIN_TRANSACTION_NOT_FOUND',
        message,
        'Not Found',
      ),
    );
  }
}

export class AdminTransactionNotReversibleError extends UnprocessableEntityException {
  constructor(message: string) {
    super(
      body(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'ADMIN_TRANSACTION_NOT_REVERSIBLE',
        message,
        'Unprocessable Entity',
      ),
    );
  }
}

export class AdminTransactionAlreadyReversedError extends ConflictException {
  constructor(message = 'Transaction already reversed.') {
    super(
      body(
        HttpStatus.CONFLICT,
        'ADMIN_TRANSACTION_ALREADY_REVERSED',
        message,
        'Conflict',
      ),
    );
  }
}
