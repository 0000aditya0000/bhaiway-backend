import { EventEmitter } from 'events';

import {
  RedisConfigurationError,
  resolveRedisConnectionConfig,
  safeRedisErrorMessage,
} from './redis-config';
import {
  attachRedisLifecycleLogs,
  buildRedisOptions,
} from './redis.provider';

describe('resolveRedisConnectionConfig', () => {
  it('prefers REDIS_URL redis:// over host/port', () => {
    const resolved = resolveRedisConnectionConfig({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://cache.example:6379/0',
      REDIS_HOST: 'ignored-host',
      REDIS_PORT: '9999',
      REDIS_PASSWORD: 'ignored-password',
    });

    expect(resolved).toEqual({
      source: 'url',
      url: 'redis://cache.example:6379/0',
      tls: false,
    });
  });

  it('supports REDIS_URL rediss:// with TLS flag', () => {
    const resolved = resolveRedisConnectionConfig({
      NODE_ENV: 'production',
      REDIS_URL: 'rediss://cache.example:6380',
    });

    expect(resolved).toEqual({
      source: 'url',
      url: 'rediss://cache.example:6380',
      tls: true,
    });

    const built = buildRedisOptions(resolved);
    expect(built.url).toBe('rediss://cache.example:6380');
    expect(built.options.tls).toEqual({});
  });

  it('supports REDIS_URL with username and password (ACL)', () => {
    const resolved = resolveRedisConnectionConfig({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://acl-user:acl-secret@cache.example:6379',
    });

    expect(resolved.source).toBe('url');
    if (resolved.source === 'url') {
      expect(resolved.url).toContain('acl-user');
      expect(resolved.url).toContain('acl-secret');
      expect(resolved.tls).toBe(false);
    }
  });

  it('falls back to REDIS_HOST / REDIS_PORT / REDIS_PASSWORD', () => {
    const resolved = resolveRedisConnectionConfig({
      NODE_ENV: 'production',
      REDIS_HOST: 'redis.internal',
      REDIS_PORT: '6380',
      REDIS_PASSWORD: 'host-secret',
      REDIS_USERNAME: 'acl-user',
    });

    expect(resolved).toEqual({
      source: 'discrete',
      host: 'redis.internal',
      port: 6380,
      username: 'acl-user',
      password: 'host-secret',
    });

    const built = buildRedisOptions(resolved);
    expect(built.url).toBeUndefined();
    expect(built.options).toMatchObject({
      host: 'redis.internal',
      port: 6380,
      username: 'acl-user',
      password: 'host-secret',
    });
  });

  it('uses localhost only in non-production when Redis is unset', () => {
    const resolved = resolveRedisConnectionConfig({
      NODE_ENV: 'development',
    });

    expect(resolved).toEqual({
      source: 'localhost-dev',
      host: 'localhost',
      port: 6379,
    });
  });

  it('fails clearly in production when Redis configuration is missing', () => {
    expect(() =>
      resolveRedisConnectionConfig({
        NODE_ENV: 'production',
      }),
    ).toThrow(RedisConfigurationError);

    expect(() =>
      resolveRedisConnectionConfig({
        NODE_ENV: 'production',
        REDIS_HOST: '   ',
        REDIS_URL: '',
      }),
    ).toThrow(/Configuration missing in production/);
  });

  it('rejects invalid REDIS_URL schemes', () => {
    expect(() =>
      resolveRedisConnectionConfig({
        NODE_ENV: 'production',
        REDIS_URL: 'http://cache.example:6379',
      }),
    ).toThrow(/redis:\/\/ or rediss:\/\//);
  });
});

describe('safeRedisErrorMessage', () => {
  it('never returns passwords or connection URLs', () => {
    const err = new Error(
      'connect ECONNREFUSED redis://acl-user:super-secret@cache.example:6379 failed password=super-secret',
    );
    (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';

    const safe = safeRedisErrorMessage(err);

    expect(safe).toContain('ECONNREFUSED');
    expect(safe).not.toContain('super-secret');
    expect(safe).not.toContain('redis://');
    expect(safe).not.toContain('acl-user');
    expect(safe).toContain('[redacted');
  });
});

describe('attachRedisLifecycleLogs', () => {
  it('logs lifecycle events without secrets and rate-limits reconnecting', () => {
    const client = new EventEmitter() as EventEmitter & {
      on: EventEmitter['on'];
    };
    const log = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    attachRedisLifecycleLogs(client as never, log);

    expect(log.log).toHaveBeenCalledWith('[Redis] Connecting...');

    client.emit('connect');
    client.emit('ready');
    client.emit(
      'error',
      Object.assign(
        new Error('Failed redis://user:leaked-password@host:6379'),
        { code: 'ECONNREFUSED' },
      ),
    );
    client.emit('reconnecting');
    client.emit('reconnecting');
    client.emit('end');

    const allText = [
      ...log.log.mock.calls,
      ...log.warn.mock.calls,
      ...log.error.mock.calls,
    ]
      .flat()
      .join('\n');

    expect(log.log).toHaveBeenCalledWith('[Redis] Connected');
    expect(log.log).toHaveBeenCalledWith('[Redis] Ready');
    expect(log.log).toHaveBeenCalledWith('[Redis] Closed');
    expect(log.warn).toHaveBeenCalledWith('[Redis] Reconnecting');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toMatch(/^\[Redis\] Connection error:/);
    expect(allText).not.toContain('leaked-password');
    expect(allText).not.toContain('redis://');
  });
});
