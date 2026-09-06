import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';

export class ChatClosedError extends ConflictException {
  constructor(
    message = 'This chat is closed because the ride or booking has ended.',
  ) {
    super({
      statusCode: 409,
      code: 'CHAT_CLOSED',
      message,
      error: 'Conflict',
    });
  }
}

export class ChatForbiddenError extends ForbiddenException {
  constructor(message = 'You are not a participant of this conversation.') {
    super({
      statusCode: 403,
      code: 'CHAT_FORBIDDEN',
      message,
      error: 'Forbidden',
    });
  }
}

export class ChatMessageValidationError extends BadRequestException {
  constructor(message: string) {
    super({
      statusCode: 400,
      code: 'CHAT_MESSAGE_INVALID',
      message,
      error: 'Bad Request',
    });
  }
}
