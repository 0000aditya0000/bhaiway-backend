import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from 'crypto';

export const PICKUP_OTP_MAX_ATTEMPTS = 5;
export const PICKUP_OTP_TTL_MS = 48 * 60 * 60 * 1000;

/** Cryptographically secure 4-digit OTP (0000–9999). */
export function generatePickupOtp(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}

export function hashPickupOtp(
  otp: string,
  bookingId: string,
  pepper: string,
): string {
  return createHmac('sha256', pepper)
    .update(`${bookingId}:${otp}`)
    .digest('hex');
}

export function pickupOtpHashesMatch(
  expectedHash: string,
  candidateHash: string,
): boolean {
  const a = Buffer.from(expectedHash, 'utf8');
  const b = Buffer.from(candidateHash, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, 'bhaiway-pickup-otp-v1', 32);
}

/**
 * Encrypts the rider-display OTP at rest (AES-256-GCM).
 * Driver APIs must never decrypt or return this value.
 */
export function encryptPickupOtp(otp: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(otp, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

export function decryptPickupOtp(
  ciphertext: string,
  secret: string,
): string | null {
  try {
    const raw = Buffer.from(ciphertext, 'base64url');
    if (raw.length < 12 + 16 + 1) {
      return null;
    }
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const key = deriveKey(secret);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    return null;
  }
}

export function isValidPickupOtpFormat(otp: string): boolean {
  return /^\d{4}$/.test(otp);
}
