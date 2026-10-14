import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

import { Public } from '../auth/decorators/public.decorator';
import { getMetricsSnapshot } from '../common/logging/metrics.registry';
import { isSentryEnabled } from '../common/logging/sentry.optional';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  /** Liveness: process is up. No dependency checks. */
  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  live() {
    return {
      status: 'ok',
      service: 'bhaiway-api',
      ts: new Date().toISOString(),
    };
  }

  /**
   * Readiness: required dependencies reachable.
   * Does not expose connection strings, versions, or secrets.
   */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe' })
  async ready() {
    let database: 'up' | 'down' = 'down';
    try {
      await this.dataSource.query('SELECT 1');
      database = 'up';
    } catch {
      database = 'down';
    }

    const ready = database === 'up';
    const body = {
      status: ready ? 'ok' : 'degraded',
      checks: { database },
      // Metrics are low-cardinality counters only.
      metrics: getMetricsSnapshot(),
      sentry: isSentryEnabled() ? 'configured' : 'disabled',
      environment: this.configService.get<string>('NODE_ENV') ?? 'development',
    };

    if (!ready) {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }
}
