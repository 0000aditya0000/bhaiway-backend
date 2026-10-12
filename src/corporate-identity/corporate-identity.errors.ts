import { HttpException, HttpStatus } from '@nestjs/common';

export class CorporateEmailNotAllowedError extends HttpException {
  constructor(
    message = 'Please use your official company email address.',
  ) {
    super(
      {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'CORPORATE_EMAIL_NOT_ALLOWED',
        message,
        error: 'Unprocessable Entity',
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
