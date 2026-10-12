import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';

const KEY_SALT = 'bhaiway-bank-account-v1';

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, KEY_SALT, 32);
}

/**
 * Encrypts a bank account number at rest (AES-256-GCM).
 * Output: base64url(iv[12] | authTag[16] | ciphertext).
 */
export function encryptAccountNumber(
  accountNumber: string,
  secret: string,
): string {
  if (!secret) {
    throw new Error('Encryption secret is not configured');
  }
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(accountNumber, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

/** Returns null when the ciphertext is malformed or fails authentication. */
export function decryptAccountNumber(
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
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    return null;
  }
}

/** XXXX XXXX 1234 (always last4 visible; never reveals more). */
export function maskAccountNumber(last4: string | null | undefined): string {
  const tail = (last4 ?? '').replace(/\D/g, '').slice(-4).padStart(4, 'X');
  return `XXXX XXXX ${tail}`;
}
