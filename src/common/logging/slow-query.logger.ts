import { Logger as TypeOrmLogger, QueryRunner } from 'typeorm';

import { logEvent } from './structured-logger';

/**
 * TypeORM logger that never dumps SQL parameters (may contain PII).
 * Emits slow-query warnings when duration exceeds threshold.
 */
export class SlowQueryTypeOrmLogger implements TypeOrmLogger {
  constructor(private readonly slowMs: number) {}

  logQuery(_query: string, _parameters?: unknown[], _queryRunner?: QueryRunner) {
    // Intentionally silent — avoid unrestricted query logging in production.
  }

  logQueryError(
    error: string | Error,
    query: string,
    _parameters?: unknown[],
    _queryRunner?: QueryRunner,
  ) {
    logEvent(
      'error',
      'db.query.failed',
      {
        errorName: error instanceof Error ? error.name : 'QueryError',
        message: error instanceof Error ? error.message : String(error),
        sqlPreview: sanitizeSqlPreview(query),
      },
      'Database query failed',
    );
  }

  logQuerySlow(
    time: number,
    query: string,
    _parameters?: unknown[],
    _queryRunner?: QueryRunner,
  ) {
    if (time < this.slowMs) {
      return;
    }
    logEvent(
      'warn',
      'db.query.slow',
      {
        durationMs: time,
        sqlPreview: sanitizeSqlPreview(query),
      },
      'Slow database query',
    );
  }

  logSchemaBuild(_message: string, _queryRunner?: QueryRunner) {
    // no-op
  }

  logMigration(message: string, _queryRunner?: QueryRunner) {
    logEvent('info', 'db.migration', { message }, 'Migration log');
  }

  log(
    level: 'log' | 'info' | 'warn',
    message: unknown,
    _queryRunner?: QueryRunner,
  ) {
    if (level === 'warn') {
      logEvent('warn', 'db.log', { message: String(message) });
    }
  }
}

function sanitizeSqlPreview(query: string): string {
  const compact = query.replace(/\s+/g, ' ').trim();
  return compact.length > 240 ? `${compact.slice(0, 240)}…` : compact;
}

export function buildTypeOrmLoggingOptions(
  nodeEnv: string | undefined,
  slowMsRaw: string | undefined,
): {
  logging: boolean | 'all';
  logger?: SlowQueryTypeOrmLogger;
  maxQueryExecutionTime: number;
} {
  const slowMs = Number(slowMsRaw ?? '1000');
  const threshold = Number.isFinite(slowMs) && slowMs > 0 ? slowMs : 1000;

  if (nodeEnv === 'development' && process.env.TYPEORM_LOGGING === 'all') {
    return {
      logging: 'all',
      maxQueryExecutionTime: threshold,
    };
  }

  return {
    // Enable logger callbacks for errors/slow queries without dumping every query.
    logging: true,
    logger: new SlowQueryTypeOrmLogger(threshold),
    maxQueryExecutionTime: threshold,
  };
}
