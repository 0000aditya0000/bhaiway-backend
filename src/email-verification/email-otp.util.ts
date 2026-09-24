import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';

import {
  EMAIL_OTP_HASH_PREFIX,
  EMAIL_OTP_MAX_EXCLUSIVE,
  EMAIL_OTP_MIN,
} from './email-verification.constants';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmailOtpFormat(otp: string): boolean {
  return /^\d{4}$/.test(otp);
}

/** Cryptographically secure 4-digit OTP in the range 1000–9999. */
export function generateEmailOtp(): string {
  return String(randomInt(EMAIL_OTP_MIN, EMAIL_OTP_MAX_EXCLUSIVE));
}

export function hashEmailOtp(params: {
  otp: string;
  userId: string;
  email: string;
  pepper: string;
  saltHex?: string;
}): string {
  const saltHex = params.saltHex ?? randomBytes(16).toString('hex');
  const digest = createHmac('sha256', params.pepper)
    .update(`${saltHex}:${params.userId}:${params.email}:${params.otp}`)
    .digest('hex');
  return `${EMAIL_OTP_HASH_PREFIX}$${saltHex}$${digest}`;
}

export function emailOtpHashesMatch(
  storedHash: string,
  candidateOtp: string,
  userId: string,
  email: string,
  pepper: string,
): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== EMAIL_OTP_HASH_PREFIX) {
    return false;
  }

  const candidateHash = hashEmailOtp({
    otp: candidateOtp,
    userId,
    email,
    pepper,
    saltHex: parts[1],
  });

  const expected = Buffer.from(storedHash, 'utf8');
  const actual = Buffer.from(candidateHash, 'utf8');
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}
