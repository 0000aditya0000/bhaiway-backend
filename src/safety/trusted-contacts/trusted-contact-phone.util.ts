/**
 * Normalize an India-focused mobile number to `+91XXXXXXXXXX`.
 * Accepts: 10-digit, 91XXXXXXXXXX, +91XXXXXXXXXX, with spaces/dashes.
 */
export function normalizeTrustedContactPhone(raw: string): string | null {
  if (raw == null) {
    return null;
  }
  const trimmed = String(raw).trim();
  if (!trimmed) {
    return null;
  }

  let digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    digits = `+${digits.slice(1).replace(/\D/g, '')}`;
  } else {
    digits = digits.replace(/\D/g, '');
  }

  if (digits.startsWith('+91') && digits.length === 13) {
    const national = digits.slice(3);
    if (/^[6-9]\d{9}$/.test(national)) {
      return `+91${national}`;
    }
    return null;
  }

  if (digits.startsWith('91') && digits.length === 12) {
    const national = digits.slice(2);
    if (/^[6-9]\d{9}$/.test(national)) {
      return `+91${national}`;
    }
    return null;
  }

  if (/^[6-9]\d{9}$/.test(digits)) {
    return `+91${digits}`;
  }

  return null;
}

export function isValidTrustedContactPhone(raw: string): boolean {
  return normalizeTrustedContactPhone(raw) != null;
}
