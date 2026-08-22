import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

import { REDIS_CLIENT } from '../tracking.constants';
import {
  describeRedisConfig,
  resolveRedisConnectionConfig,
  safeRedisErrorMessage,
  type ResolvedRedisConfig,
} from './redis-config';

const logger = new Logger('Redis');

/**
 * Builds ioredis options from a normalized config.
 * Never passes a redis(s):// URL string into the constructor — avoids
 * conflicting URL-implied TLS with an explicit `tls` option (Upstash).
 */
export function buildRedisOptions(resolved: ResolvedRedisConfig): RedisOptions {
  const options: RedisOptions = {
    host: resolved.host,
    port: resolved.port,
    db: resolved.db ?? 0,
    ...(resolved.username ? { username: resolved.username } : {}),
    ...(resolved.password ? { password: resolved.password } : {}),
    // Fail the command quickly instead of queuing during reconnect (avoids 4–5s hangs).
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    // Helps keep Upstash/serverless Redis connections from going silently dead.
    keepAlive: 10_000,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times: number) => {
      // Cap backoff; stop after sustained failure so we don't reconnect forever silently.
      if (times > 30) {
        return null;
      }
      return Math.min(times * 200, 2_000);
    },
  };

  if (resolved.tls) {
    // Single TLS path with SNI (servername) — required for many managed Redis certs.
    options.tls = {
      servername: resolved.host,
    };
  }

  return options;
}

export function createRedisClient(resolved: ResolvedRedisConfig): Redis {
  return new Redis(buildRedisOptions(resolved));
}

/**
 * Attaches lifecycle listeners. Reconnecting is rate-limited to avoid log spam.
 * Never logs URLs, passwords, or other secrets.
 */
export function attachRedisLifecycleLogs(
  client: Redis,
  log: Pick<Logger, 'log' | 'warn' | 'error'> = logger,
): void {
  let lastReconnectLogAt = 0;
  const reconnectLogIntervalMs = 10_000;

  log.log('[Redis] Connecting...');

  client.on('connect', () => {
    log.log('[Redis] Connected');
  });

  client.on('ready', () => {
    log.log('[Redis] Ready');
  });

  client.on('error', (err: Error) => {
    log.error(`[Redis] Connection error: ${safeRedisErrorMessage(err)}`);
  });

  client.on('reconnecting', () => {
    const now = Date.now();
    if (now - lastReconnectLogAt >= reconnectLogIntervalMs) {
      lastReconnectLogAt = now;
      log.warn(`[Redis] Reconnecting (status=${client.status})`);
    }
  });

  client.on('end', () => {
    log.log('[Redis] Closed');
  });

  client.on('close', () => {
    log.warn('[Redis] Connection closed');
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
