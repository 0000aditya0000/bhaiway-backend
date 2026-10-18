/** Mask phone for admin directory UIs — keep last 4 digits. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone?.trim()) {
    return null;
  }
  const trimmed = phone.trim();
  if (trimmed.length <= 4) {
    return trimmed;
  }
  return `${'*'.repeat(Math.min(trimmed.length - 4, 8))}${trimmed.slice(-4)}`;
}

/** Mask email local-part for admin directory UIs. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email?.trim()) {
    return null;
  }
  const trimmed = email.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0) {
    return '***';
  }
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const visible = local.slice(0, Math.min(1, local.length));
  return `${visible}***@${domain}`;
}

/** Mask vehicle registration — keep last 4 characters. */
export function maskRegistration(
  value: string | null | undefined,
): string | null {
  if (!value?.trim()) {
    return null;
  }
  const trimmed = value.trim().toUpperCase();
  if (trimmed.length <= 4) {
    return trimmed;
  }
  return `${'*'.repeat(Math.min(trimmed.length - 4, 6))}${trimmed.slice(-4)}`;
}
