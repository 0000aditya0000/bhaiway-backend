import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

import { REDIS_CLIENT } from '../tracking.constants';
import {
  resolveRedisConnectionConfig,
  safeRedisErrorMessage,
  type ResolvedRedisConfig,
} from './redis-config';

const logger = new Logger('Redis');

export function buildRedisOptions(
  resolved: ResolvedRedisConfig,
): { url?: string; options: RedisOptions } {
  const base: RedisOptions = {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  };

  if (resolved.source === 'url') {
    return {
      url: resolved.url,
      options: {
        ...base,
        // Explicit TLS for rediss:// in addition to ioredis URL handling.
        ...(resolved.tls ? { tls: {} } : {}),
      },
    };
  }

  return {
    options: {
      ...base,
      host: resolved.host,
      port: resolved.port,
      ...(resolved.source === 'discrete' && resolved.username
        ? { username: resolved.username }
        : {}),
      ...(resolved.source === 'discrete' && resolved.password
        ? { password: resolved.password }
        : {}),
    },
  };
}

export function createRedisClient(resolved: ResolvedRedisConfig): Redis {
  const built = buildRedisOptions(resolved);
  if (built.url) {
    return new Redis(built.url, built.options);
  }
  return new Redis(built.options);
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
      log.warn('[Redis] Reconnecting');
    }
  });

  client.on('end', () => {
    log.log('[Redis] Closed');
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

    const client = createRedisClient(resolved);
    attachRedisLifecycleLogs(client);
    return client;
  },
};
