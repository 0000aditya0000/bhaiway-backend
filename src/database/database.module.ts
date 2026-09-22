import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { postgresSslFromUrl } from './postgres-url';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const url = configService.getOrThrow<string>('DATABASE_URL');
        return {
          type: 'postgres' as const,
          url,
          ssl: postgresSslFromUrl(url),
          autoLoadEntities: true,
          synchronize: false,
          logging: configService.get<string>('NODE_ENV') === 'development',
        };
      },
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}