/**
 * Pure Redis connection resolution (no I/O).
 * Priority: REDIS_URL → REDIS_HOST(+PORT/PASSWORD/USERNAME) → localhost (dev only).
 *
 * When REDIS_URL is set, the raw URL is preserved for ioredis (Upstash-recommended).
 * Discrete host/port/user/pass are also parsed for safe diagnostics only.
 */

export type RedisEnvSnapshot = {
  NODE_ENV?: string | null;
  REDIS_URL?: string | null;
  REDIS_HOST?: string | null;
  REDIS_PORT?: string | null;
  REDIS_PASSWORD?: string | null;
  REDIS_USERNAME?: string | null;
};

export type ResolvedRedisConfig = {
  /** How the config was sourced (for diagnostics only — never log secrets). */
  source: 'url' | 'discrete' | 'localhost-dev';
  /**
   * Original redis:// or rediss:// URL when source=url.
   * Passed verbatim to ioredis — never log this value.
   */
  connectionUrl?: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** True when connection uses TLS (rediss:// or upgraded Upstash URL). */
  tls: boolean;
  db?: number;
  /** True when redis://…upstash.io was auto-upgraded to rediss://. */
  tlsUpgradedFromPlainRedis?: boolean;
};

export class RedisConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisConfigurationError';
  }
}

function trim(value: string | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const t = String(value).trim();
  return t.length > 0 ? t : undefined;
}

/** Strip accidental wrapping quotes from Render/dashboard copy-paste. */
function normalizeEnvValue(value: string | null | undefined): string | undefined {
  const t = trim(value);
  if (!t) {
    return undefined;
  }
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return trim(t.slice(1, -1));
  }
  return t;
}

function isProduction(nodeEnv: string | null | undefined): boolean {
  return (nodeEnv ?? '').trim().toLowerCase() === 'production';
}

function decodeUriComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Upstash requires TLS. If someone pastes redis://…upstash.io…, upgrade to rediss://
 * without re-serializing userinfo (avoids breaking token encoding).
 */
export function normalizeRedisConnectionUrl(redisUrl: string): {
  url: string;
  tlsUpgraded: boolean;
  host: string;
  tls: boolean;
} {
  const parsed = new URL(redisUrl);
  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.hostname;
  const isUpstash = host.toLowerCase().endsWith('.upstash.io');

  if (protocol === 'redis:' && isUpstash) {
    return {
      url: `rediss://${redisUrl.slice('redis://'.length)}`,
      tlsUpgraded: true,
      host,
      tls: true,
    };
  }

  return {
    url: redisUrl,
    tlsUpgraded: false,
    host,
    tls: protocol === 'rediss:',
  };
}

/**
 * Resolves Redis connection settings from environment.
 * Throws RedisConfigurationError in production when Redis is not configured.
 */
export function resolveRedisConnectionConfig(
  env: RedisEnvSnapshot,
): ResolvedRedisConfig {
  const redisUrlRaw = normalizeEnvValue(env.REDIS_URL);
  if (redisUrlRaw) {
    let parsed: URL;
    try {
      parsed = new URL(redisUrlRaw);
    } catch {
      throw new RedisConfigurationError(
        '[Redis] REDIS_URL is invalid. Expected redis:// or rediss:// URL.',
      );
    }

    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'redis:' && protocol !== 'rediss:') {
      throw new RedisConfigurationError(
        '[Redis] REDIS_URL must use redis:// or rediss:// scheme (not https:// REST).',
      );
    }

    if (!parsed.hostname) {
      throw new RedisConfigurationError(
        '[Redis] REDIS_URL is missing a hostname.',
      );
    }

    const normalized = normalizeRedisConnectionUrl(redisUrlRaw);
    // Re-parse after possible redis→rediss upgrade so fields stay consistent.
    parsed = new URL(normalized.url);

    const port = parsed.port ? Number(parsed.port) : 6379;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new RedisConfigurationError(
        '[Redis] REDIS_URL port is invalid.',
      );
    }

    const username = parsed.username
      ? decodeUriComponentSafe(parsed.username)
      : undefined;
    const password = parsed.password
      ? decodeUriComponentSafe(parsed.password)
      : undefined;

    let db: number | undefined;
    if (parsed.pathname && parsed.pathname.length > 1) {
      const dbRaw = Number(parsed.pathname.slice(1));
      if (Number.isFinite(dbRaw) && dbRaw >= 0) {
        db = dbRaw;
      }
    }

    return {
      source: 'url',
      connectionUrl: normalized.url,
      host: parsed.hostname,
      port,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      tls: normalized.tls,
      ...(db !== undefined ? { db } : {}),
      ...(normalized.tlsUpgraded
        ? { tlsUpgradedFromPlainRedis: true as const }
        : {}),
    };
  }

  const host = normalizeEnvValue(env.REDIS_HOST);
  if (host) {
    const portRaw = normalizeEnvValue(env.REDIS_PORT);
    const port = portRaw ? Number(portRaw) : 6379;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new RedisConfigurationError(
        '[Redis] REDIS_PORT must be a valid TCP port number.',
      );
    }

    const username = normalizeEnvValue(env.REDIS_USERNAME);
    const password = normalizeEnvValue(env.REDIS_PASSWORD);

    return {
      source: 'discrete',
      host,
      port,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      tls: false,
    };
  }

  if (isProduction(env.NODE_ENV)) {
    throw new RedisConfigurationError(
      '[Redis] Configuration missing in production. Set REDIS_URL (preferred) or REDIS_HOST (+ REDIS_PORT / REDIS_PASSWORD as needed). Refusing to fall back to localhost.',
    );
  }

  return {
    source: 'localhost-dev',
    host: 'localhost',
    port: 6379,
    tls: false,
  };
}

/** Safe, non-secret summary for startup / request diagnostics. */
export function describeRedisConfig(resolved: ResolvedRedisConfig): string {
  return `source=${resolved.source} host=${resolved.host} port=${resolved.port} tls=${resolved.tls} tlsUpgraded=${Boolean(resolved.tlsUpgradedFromPlainRedis)} username=${resolved.username ? 'set' : 'none'} password=${resolved.password ? 'set' : 'none'} db=${resolved.db ?? 0} urlMode=${resolved.connectionUrl ? 'verbatim' : 'discrete'}`;
}

/** Safe error text for logs — never include URLs or credential material. */
export function safeRedisErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return 'unknown error';
  }

  const name = err.name || 'Error';
  const code =
    typeof (err as NodeJS.ErrnoException).code === 'string'
      ? (err as NodeJS.ErrnoException).code
      : undefined;

  let message = err.message ?? name;
  message = message
    .replace(/rediss?:\/\/[^\s"'`]+/gi, '[redacted-url]')
    .replace(/(password|pwd|auth)([=:\s]+)([^\s,;]+)/gi, '$1$2[redacted]')
    .replace(/\/\/([^/@\s]+):([^@/\s]+)@/g, '//[redacted]@');

  if (code) {
    return `${name} ${code}: ${message}`;
  }
  return `${name}: ${message}`;
}

export function isTransientRedisCommandError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.name === 'MaxRetriesPerRequestError' ||
    /max retries per request/i.test(err.message) ||
    /Stream isn't writeable/i.test(err.message) ||
    /Connection is closed/i.test(err.message)
  );
}
