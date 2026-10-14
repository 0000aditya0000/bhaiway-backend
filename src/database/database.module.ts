import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { buildTypeOrmLoggingOptions } from '../common/logging/slow-query.logger';
import { postgresSslFromUrl } from './postgres-url';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const url = configService.getOrThrow<string>('DATABASE_URL');
        const nodeEnv = configService.get<string>('NODE_ENV');
        const loggingOptions = buildTypeOrmLoggingOptions(
          nodeEnv,
          configService.get<string>('DB_SLOW_QUERY_MS'),
        );
        return {
          type: 'postgres' as const,
          url,
          ssl: postgresSslFromUrl(url),
          autoLoadEntities: true,
          synchronize: false,
          ...loggingOptions,
        };
      },
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
