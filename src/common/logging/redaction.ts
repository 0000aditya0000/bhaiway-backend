import { SENSITIVE_FIELD_KEYS } from './logging.constants';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_SET = new Set(
  SENSITIVE_FIELD_KEYS.map((k) => k.toLowerCase()),
);

const SENSITIVE_KEY_SUBSTRINGS = [
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'otp',
  'aadhaar',
  'signature',
  'apikey',
  'api_key',
  'private',
  'credential',
  'upi',
  'accountnumber',
  'bank',
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_KEY_SET.has(key.toLowerCase())) {
    return true;
  }
  return SENSITIVE_KEY_SUBSTRINGS.some((part) => normalized.includes(part));
}

/**
 * Deep-redact known secret/PII keys. Never throws; returns a safe summary on failure.
 */
export function redactSensitive(
  value: unknown,
  depth = 0,
  maxDepth = 6,
): unknown {
  try {
    if (depth > maxDepth) {
      return '[MAX_DEPTH]';
    }
    if (value == null) {
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > 512) {
        return `${value.slice(0, 64)}…[truncated ${value.length} chars]`;
      }
      return value;
    }
    if (typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => redactSensitive(item, depth + 1, maxDepth));
    }
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactSensitive(nested, depth + 1, maxDepth);
      }
    }
    return out;
  } catch {
    return { error: 'redaction_failed' };
  }
}

/** Strip query string and replace UUID/numeric path segments for safe logging. */
export function normalizeRoutePath(
  urlOrPath: string,
  routeTemplate?: string | null,
  baseUrl?: string | null,
): string {
  if (routeTemplate && routeTemplate.length > 0) {
    const base = (baseUrl ?? '').replace(/\/$/, '');
    const path = routeTemplate.startsWith('/')
      ? routeTemplate
      : `/${routeTemplate}`;
    const combined = `${base}${path}` || '/';
    return combined.replace(/\/{2,}/g, '/');
  }

  const q = urlOrPath.indexOf('?');
  let path = q >= 0 ? urlOrPath.slice(0, q) : urlOrPath;
  if (!path) {
    return '/';
  }
  // Redact UUID-like and long numeric IDs from unmatched routes.
  path = path.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
    ':id',
  );
  path = path.replace(/\/\d{6,}/g, '/:id');
  return path;
}

export function pickAllowlistedFields(
  source: Record<string, unknown> | null | undefined,
  allowlist: readonly string[],
): Record<string, unknown> | undefined {
  if (!source || allowlist.length === 0) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const key of allowlist) {
    if (Object.prototype.hasOwnProperty.call(source, key) && !isSensitiveKey(key)) {
      out[key] = redactSensitive(source[key], 0, 2);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
