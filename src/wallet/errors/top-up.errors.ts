import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

export class TopUpIdempotencyConflictError extends ConflictException {
  constructor(message = 'Idempotency-Key reused with a different top-up amount') {
    super(message);
  }
}

export class InvalidPaymentCallbackError extends BadRequestException {
  constructor(message = 'Invalid payment callback signature or payload') {
    super(message);
  }
}

export class PaymentOrderNotFoundError extends NotFoundException {
  constructor(message = 'Payment order not found') {
    super(message);
  }
}

export class PaymentCallbackAmountMismatchError extends UnprocessableEntityException {
  constructor(message = 'Callback amount does not match payment order') {
    super(message);
  }
}

export class PaymentCallbackCurrencyMismatchError extends UnprocessableEntityException {
  constructor(message = 'Callback currency does not match payment order') {
    super(message);
  }
}

export class PaymentOrderTerminalStateError extends ConflictException {
  constructor(
    message = 'Payment order is in a terminal state and cannot be credited',
  ) {
    super(message);
  }
}
