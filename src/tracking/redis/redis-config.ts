/**
 * Pure Redis connection resolution (no I/O).
 * Priority: REDIS_URL → REDIS_HOST(+PORT/PASSWORD/USERNAME) → localhost (dev only).
 */

export type RedisEnvSnapshot = {
  NODE_ENV?: string | null;
  REDIS_URL?: string | null;
  REDIS_HOST?: string | null;
  REDIS_PORT?: string | null;
  REDIS_PASSWORD?: string | null;
  REDIS_USERNAME?: string | null;
};

export type ResolvedRedisConfig =
  | {
      source: 'url';
      /** Full connection URL; never log this value. */
      url: string;
      tls: boolean;
    }
  | {
      source: 'discrete';
      host: string;
      port: number;
      username?: string;
      password?: string;
    }
  | {
      source: 'localhost-dev';
      host: 'localhost';
      port: 6379;
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

function isProduction(nodeEnv: string | null | undefined): boolean {
  return (nodeEnv ?? '').trim().toLowerCase() === 'production';
}

/**
 * Resolves Redis connection settings from environment.
 * Throws RedisConfigurationError in production when Redis is not configured.
 */
export function resolveRedisConnectionConfig(
  env: RedisEnvSnapshot,
): ResolvedRedisConfig {
  const redisUrl = trim(env.REDIS_URL);
  if (redisUrl) {
    let parsed: URL;
    try {
      parsed = new URL(redisUrl);
    } catch {
      throw new RedisConfigurationError(
        '[Redis] REDIS_URL is invalid. Expected redis:// or rediss:// URL.',
      );
    }

    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'redis:' && protocol !== 'rediss:') {
      throw new RedisConfigurationError(
        '[Redis] REDIS_URL must use redis:// or rediss:// scheme.',
      );
    }

    return {
      source: 'url',
      url: redisUrl,
      tls: protocol === 'rediss:',
    };
  }

  const host = trim(env.REDIS_HOST);
  if (host) {
    const portRaw = trim(env.REDIS_PORT);
    const port = portRaw ? Number(portRaw) : 6379;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new RedisConfigurationError(
        '[Redis] REDIS_PORT must be a valid TCP port number.',
      );
    }

    const username = trim(env.REDIS_USERNAME);
    const password = trim(env.REDIS_PASSWORD);

    return {
      source: 'discrete',
      host,
      port,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
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
  };
}

/** Safe error text for logs — never include URLs or credential material. */
export function safeRedisErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return 'unknown error';
  }

  const code =
    typeof (err as NodeJS.ErrnoException).code === 'string'
      ? (err as NodeJS.ErrnoException).code
      : undefined;

  let message = err.message ?? err.name ?? 'Error';
  message = message
    .replace(/rediss?:\/\/[^\s"'`]+/gi, '[redacted-url]')
    .replace(/(password|pwd|auth)([=:\s]+)([^\s,;]+)/gi, '$1$2[redacted]')
    .replace(/\/\/([^/@\s]+):([^@/\s]+)@/g, '//[redacted]@');

  if (code) {
    return `${code}: ${message}`;
  }
  return message;
}
