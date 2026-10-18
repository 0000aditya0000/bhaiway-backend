import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

export class SupportTicketNotFoundError extends NotFoundException {
  constructor(message = 'Support ticket not found') {
    super({
      statusCode: 404,
      code: 'SUPPORT_TICKET_NOT_FOUND',
      message,
      error: 'Not Found',
    });
  }
}

export class SupportInvalidCategoryError extends BadRequestException {
  constructor(message = 'Invalid support category or subcategory') {
    super({
      statusCode: 400,
      code: 'SUPPORT_INVALID_CATEGORY',
      message,
      error: 'Bad Request',
    });
  }
}

export class SupportRideRequiredError extends BadRequestException {
  constructor(message = 'A related ride is required for this category') {
    super({
      statusCode: 400,
      code: 'SUPPORT_RIDE_REQUIRED',
      message,
      error: 'Bad Request',
    });
  }
}

export class SupportRideIneligibleError extends UnprocessableEntityException {
  constructor(message = 'Selected ride is not eligible for a support ticket') {
    super({
      statusCode: 422,
      code: 'SUPPORT_RIDE_INELIGIBLE',
      message,
      error: 'Unprocessable Entity',
    });
  }
}

export class SupportRideForbiddenError extends ForbiddenException {
  constructor(message = 'You cannot create a ticket for this ride') {
    super({
      statusCode: 403,
      code: 'SUPPORT_RIDE_FORBIDDEN',
      message,
      error: 'Forbidden',
    });
  }
}

export class SupportAttachmentLimitError extends BadRequestException {
  constructor(message = 'A maximum of 3 screenshot attachments is allowed') {
    super({
      statusCode: 400,
      code: 'SUPPORT_ATTACHMENT_LIMIT',
      message,
      error: 'Bad Request',
    });
  }
}

export class SupportAttachmentInvalidError extends BadRequestException {
  constructor(message = 'Invalid screenshot attachment URL or type') {
    super({
      statusCode: 400,
      code: 'SUPPORT_ATTACHMENT_INVALID',
      message,
      error: 'Bad Request',
    });
  }
}

export class SupportStatusTransitionError extends UnprocessableEntityException {
  constructor(message = 'Invalid support ticket status transition') {
    super({
      statusCode: 422,
      code: 'SUPPORT_STATUS_TRANSITION_INVALID',
      message,
      error: 'Unprocessable Entity',
    });
  }
}

export class SupportTicketResolvedError extends ConflictException {
  constructor(message = 'Resolved tickets cannot accept new comments') {
    super({
      statusCode: 409,
      code: 'SUPPORT_TICKET_RESOLVED',
      message,
      error: 'Conflict',
    });
  }
}

export class SupportTransactionInvalidError extends UnprocessableEntityException {
  constructor(
    message = 'Wallet transaction is not associated with this account',
  ) {
    super({
      statusCode: 422,
      code: 'SUPPORT_TRANSACTION_INVALID',
      message,
      error: 'Unprocessable Entity',
    });
  }
}
