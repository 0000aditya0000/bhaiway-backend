import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

import { REDIS_CLIENT } from '../tracking.constants';
import {
  describeRedisConfig,
  isTransientRedisCommandError,
  resolveRedisConnectionConfig,
  safeRedisErrorMessage,
  type ResolvedRedisConfig,
} from './redis-config';

const logger = new Logger('Redis');

/**
 * Shared runtime options.
 *
 * Upstash path: pass REDIS_URL verbatim to `new Redis(url, options)` and do NOT
 * also set `tls` (rediss:// already enables TLS). Rebuilding host/user/pass from
 * URL previously caused Connected→Closed without Ready (AUTH/handshake break).
 *
 * enableOfflineQueue must stay true so AUTH + ready-check can complete.
 * HTTP fail-fast is handled in TrackingService via redis.status !== 'ready'.
 */
export function buildRedisOptions(resolved: ResolvedRedisConfig): RedisOptions {
  const options: RedisOptions = {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    connectTimeout: 10_000,
    keepAlive: 30_000,
    enableReadyCheck: true,
    lazyConnect: false,
    // Prefer IPv4 — Render→Upstash IPv6 can connect then drop before ready.
    family: 4,
    retryStrategy: (times: number) => {
      if (times > 20) {
        return null;
      }
      return Math.min(times * 200, 2_000);
    },
  };

  if (resolved.connectionUrl) {
    // URL mode: ioredis parses rediss:// + ACL itself. Do not add tls here.
    return options;
  }

  return {
    ...options,
    host: resolved.host,
    port: resolved.port,
    db: resolved.db ?? 0,
    ...(resolved.username ? { username: resolved.username } : {}),
    ...(resolved.password ? { password: resolved.password } : {}),
    ...(resolved.tls
      ? {
          tls: {
            servername: resolved.host,
          },
        }
      : {}),
  };
}

export function createRedisClient(resolved: ResolvedRedisConfig): Redis {
  const options = buildRedisOptions(resolved);
  if (resolved.connectionUrl) {
    return new Redis(resolved.connectionUrl, options);
  }
  return new Redis(options);
}

/**
 * Attaches lifecycle listeners. Reconnecting / transient errors are rate-limited.
 * Never logs URLs, passwords, or other secrets.
 */
export function attachRedisLifecycleLogs(
  client: Redis,
  log: Pick<Logger, 'log' | 'warn' | 'error'> = logger,
): void {
  let lastReconnectLogAt = 0;
  let lastErrorLogAt = 0;
  let sawReady = false;
  const logIntervalMs = 10_000;

  log.log('[Redis] Connecting...');

  client.on('connect', () => {
    log.log('[Redis] Connected');
  });

  client.on('ready', () => {
    sawReady = true;
    log.log('[Redis] Ready');
  });

  client.on('error', (err: Error) => {
    const now = Date.now();
    // MaxRetriesPerRequestError is noisy during reconnect — rate-limit it.
    if (
      isTransientRedisCommandError(err) &&
      now - lastErrorLogAt < logIntervalMs
    ) {
      return;
    }
    lastErrorLogAt = now;
    log.error(`[Redis] Connection error: ${safeRedisErrorMessage(err)}`);
  });

  client.on('reconnecting', () => {
    const now = Date.now();
    if (now - lastReconnectLogAt >= logIntervalMs) {
      lastReconnectLogAt = now;
      log.warn(`[Redis] Reconnecting (status=${client.status})`);
    }
  });

  client.on('end', () => {
    log.log('[Redis] Closed');
  });

  client.on('close', () => {
    if (!sawReady) {
      log.warn(
        '[Redis] Connection closed before Ready — check REDIS_URL is rediss://default:<token>@<host>.upstash.io:6379 (Redis protocol, not REST https://), and that the token has no broken quoting',
      );
    } else {
      log.warn('[Redis] Connection closed');
    }
  });
}

export const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis => {
    const resolved = resolveRedisConnectionConfig({
      NODE_ENV: config.get<string>('NODE_ENV'),
      REDIS_URL: config.get<string>('REDIS_URL'),
      REDIS_HOST: config.get<string>('REDIS_HOST'),
      REDIS_PORT: config.get<string>('REDIS_PORT'),
      REDIS_PASSWORD: config.get<string>('REDIS_PASSWORD'),
      REDIS_USERNAME: config.get<string>('REDIS_USERNAME'),
    });

    logger.log(`[Redis] Config resolved: ${describeRedisConfig(resolved)}`);

    const client = createRedisClient(resolved);
    attachRedisLifecycleLogs(client);
    return client;
  },
};
