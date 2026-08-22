import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { REDIS_CLIENT } from '../tracking.constants';

export const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis => {
    const host = config.get<string>('REDIS_HOST', 'localhost');
    const port = Number(config.get<string>('REDIS_PORT', '6379'));
    const password = config.get<string>('REDIS_PASSWORD') || undefined;

    return new Redis({
      host,
      port: Number.isFinite(port) ? port : 6379,
      password: password?.trim() ? password : undefined,
      maxRetriesPerRequest: 3,
      lazyConnect: false,
      enableReadyCheck: true,
    });
  },
};
