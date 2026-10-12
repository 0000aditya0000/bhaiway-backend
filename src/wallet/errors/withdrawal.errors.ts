import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

export class IdempotencyKeyRequiredError extends BadRequestException {
  constructor(message = 'Idempotency-Key header is required') {
    super({
      statusCode: 400,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message,
      error: 'Bad Request',
    });
  }
}

export class PaymentMethodNotFoundError extends NotFoundException {
  constructor(message = 'Payment method not found') {
    super({
      statusCode: 404,
      code: 'PAYMENT_METHOD_NOT_FOUND',
      message,
      error: 'Not Found',
    });
  }
}

export class PaymentMethodInactiveError extends UnprocessableEntityException {
  constructor(message = 'Payment method is no longer active') {
    super({
      statusCode: 422,
      code: 'PAYMENT_METHOD_INACTIVE',
      message,
      error: 'Unprocessable Entity',
    });
  }
}

export class InvalidPaymentMethodError extends BadRequestException {
  constructor(message = 'Invalid payment method details') {
    super({
      statusCode: 400,
      code: 'INVALID_PAYMENT_METHOD',
      message,
      error: 'Bad Request',
    });
  }
}

export class InvalidWithdrawalAmountError extends BadRequestException {
  constructor(message = 'Withdrawal amount must be a positive whole number of Coins') {
    super({
      statusCode: 400,
      code: 'INVALID_WITHDRAWAL_AMOUNT',
      message,
      error: 'Bad Request',
    });
  }
}

export class InsufficientWithdrawableBalanceError extends UnprocessableEntityException {
  constructor(
    message = 'Insufficient withdrawable balance. Only earned Coins can be withdrawn.',
  ) {
    super({
      statusCode: 422,
      code: 'INSUFFICIENT_WITHDRAWABLE_BALANCE',
      message,
      error: 'Unprocessable Entity',
    });
  }
}

export class WithdrawalNotFoundError extends NotFoundException {
  constructor(message = 'Withdrawal not found') {
    super({
      statusCode: 404,
      code: 'WITHDRAWAL_NOT_FOUND',
      message,
      error: 'Not Found',
    });
  }
}

export class WithdrawalAccessDeniedError extends ForbiddenException {
  constructor(message = 'You do not have access to this withdrawal') {
    super({
      statusCode: 403,
      code: 'WITHDRAWAL_ACCESS_DENIED',
      message,
      error: 'Forbidden',
    });
  }
}

export class InvalidWithdrawalStatusTransitionError extends UnprocessableEntityException {
  constructor(from: string, to: string) {
    super({
      statusCode: 422,
      code: 'INVALID_WITHDRAWAL_STATUS_TRANSITION',
      message: `Cannot change withdrawal status from ${from} to ${to}`,
      error: 'Unprocessable Entity',
    });
  }
}

export class WithdrawalAlreadyCompletedError extends ConflictException {
  constructor(message = 'Withdrawal is already completed') {
    super({
      statusCode: 409,
      code: 'WITHDRAWAL_ALREADY_COMPLETED',
      message,
      error: 'Conflict',
    });
  }
}

export class WithdrawalIdempotencyConflictError extends ConflictException {
  constructor(
    message = 'Idempotency-Key was already used with a different withdrawal request',
  ) {
    super({
      statusCode: 409,
      code: 'WITHDRAWAL_IDEMPOTENCY_CONFLICT',
      message,
      error: 'Conflict',
    });
  }
}
