import {
  ConflictException,
  ForbiddenException,
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

export class CommuteRewardNotFoundError extends NotFoundException {
  constructor(message = 'Commute reward resource not found.') {
    super(
      body(HttpStatus.NOT_FOUND, 'COMMUTE_REWARD_NOT_FOUND', message, 'Not Found'),
    );
  }
}

export class CommuteRewardInvalidStateError extends UnprocessableEntityException {
  constructor(message: string) {
    super(
      body(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'COMMUTE_REWARD_INVALID_STATE',
        message,
        'Unprocessable Entity',
      ),
    );
  }
}

export class CommuteRewardNotEligibleError extends UnprocessableEntityException {
  constructor(message = 'Milestone is not eligible to claim.') {
    super(
      body(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'COMMUTE_REWARD_NOT_ELIGIBLE',
        message,
        'Unprocessable Entity',
      ),
    );
  }
}

export class CommuteRewardAlreadyClaimedError extends ConflictException {
  constructor(message = 'This milestone has already been claimed.') {
    super(
      body(HttpStatus.CONFLICT, 'COMMUTE_REWARD_ALREADY_CLAIMED', message, 'Conflict'),
    );
  }
}

export class CommuteRewardForbiddenError extends ForbiddenException {
  constructor(message = 'Not allowed.') {
    super(
      body(HttpStatus.FORBIDDEN, 'COMMUTE_REWARD_FORBIDDEN', message, 'Forbidden'),
    );
  }
}
