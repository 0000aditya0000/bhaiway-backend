import { randomInt } from 'crypto';

import {
  REFERRAL_CODE_ALPHABET,
  REFERRAL_CODE_PREFIX,
  REFERRAL_CODE_SUFFIX_LENGTH,
} from './enums/referral.enums';

/** Trim + uppercase. Blank becomes null (treated as omitted). */
export function normalizeReferralCode(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null;
  }
  const normalized = raw.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

export function generateReferralCode(): string {
  let suffix = '';
  for (let i = 0; i < REFERRAL_CODE_SUFFIX_LENGTH; i += 1) {
    suffix += REFERRAL_CODE_ALPHABET[randomInt(0, REFERRAL_CODE_ALPHABET.length)];
  }
  return `${REFERRAL_CODE_PREFIX}${suffix}`;
}
