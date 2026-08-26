import { BadRequestException } from '@nestjs/common';

import { MAX_TOP_UP_AMOUNT_COINS } from './wallet.constants';

const POSITIVE_INTEGER_STRING = /^[1-9]\d*$/;

/**
 * Parse a client-supplied monetary amount as a positive bigint.
 * Rejects zero, negatives, decimals, and whitespace.
 */
export function parsePositiveIntegerAmount(
  amount: string,
  fieldName = 'amount',
): bigint {
  if (typeof amount !== 'string' || amount.trim() !== amount || amount.length === 0) {
    throw new BadRequestException(
      `${fieldName} must be a positive integer string`,
    );
  }

  if (!POSITIVE_INTEGER_STRING.test(amount)) {
    throw new BadRequestException(
      `${fieldName} must be a positive integer string without decimals`,
    );
  }

  const value = BigInt(amount);
  if (value <= 0n) {
    throw new BadRequestException(
      `${fieldName} must be a positive integer string`,
    );
  }

  if (value > BigInt(MAX_TOP_UP_AMOUNT_COINS)) {
    throw new BadRequestException(
      `${fieldName} exceeds the maximum top-up amount of ${MAX_TOP_UP_AMOUNT_COINS} coins`,
    );
  }

  return value;
}
