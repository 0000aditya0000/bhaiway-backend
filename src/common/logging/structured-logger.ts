import { ConsoleLogger, LogLevel, LoggerService } from '@nestjs/common';
import pino, { Logger as PinoLogger } from 'pino';

import { SERVICE_NAME } from './logging.constants';
import { getRequestContext } from './request-context';
import { redactSensitive } from './redaction';

let rootPino: PinoLogger | null = null;

function resolveLevel(): string {
  const configured = (process.env.LOG_LEVEL ?? '').trim().toLowerCase();
  if (
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].includes(
      configured,
    )
  ) {
    return configured;
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

export function getPinoLogger(): PinoLogger {
  if (!rootPino) {
    rootPino = pino({
      level: resolveLevel(),
      base: {
        service: SERVICE_NAME,
        environment: process.env.NODE_ENV ?? 'development',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'password',
          'otp',
          'accessToken',
          'refreshToken',
          '*.password',
          '*.otp',
          '*.accessToken',
          '*.authorization',
        ],
        censor: '[REDACTED]',
      },
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    });
  }
  return rootPino;
}

function withContext(fields?: Record<string, unknown>): Record<string, unknown> {
  const ctx = getRequestContext();
  const safe = fields ? (redactSensitive(fields) as Record<string, unknown>) : {};
  return {
    ...safe,
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx?.correlationId ? { correlationId: ctx.correlationId } : {}),
    ...(ctx?.userId ? { userId: ctx.userId } : {}),
    ...(ctx?.route ? { route: ctx.route } : {}),
    ...(ctx?.method ? { method: ctx.method } : {}),
  };
}

/**
 * Nest LoggerService backed by Pino structured JSON.
 * One JSON object per line — suitable for PM2 stdout capture.
 */
export class StructuredNestLogger implements LoggerService {
  private readonly pino: PinoLogger;
  private readonly context?: string;

  constructor(context?: string) {
    this.pino = getPinoLogger();
    this.context = context;
  }

  log(message: unknown, ...optionalParams: unknown[]) {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]) {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]) {
    this.write('warn', message, optionalParams);
  }

  debug?(message: unknown, ...optionalParams: unknown[]) {
    this.write('debug', message, optionalParams);
  }

  verbose?(message: unknown, ...optionalParams: unknown[]) {
    this.write('trace', message, optionalParams);
  }

  fatal?(message: unknown, ...optionalParams: unknown[]) {
    this.write('fatal', message, optionalParams);
  }

  setLogLevels?(_levels: LogLevel[]) {
    // Level controlled via LOG_LEVEL env; Nest API no-op.
  }

  private write(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: unknown,
    optionalParams: unknown[],
  ) {
    try {
      const contextName =
        typeof optionalParams[optionalParams.length - 1] === 'string'
          ? (optionalParams[optionalParams.length - 1] as string)
          : this.context;

      let fields: Record<string, unknown> = {};
      let msg = '';

      if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
        fields = message as Record<string, unknown>;
        msg =
          typeof fields['msg'] === 'string'
            ? (fields['msg'] as string)
            : typeof optionalParams[0] === 'string'
              ? (optionalParams[0] as string)
              : 'log';
      } else {
        msg = String(message);
        if (
          typeof optionalParams[0] === 'object' &&
          optionalParams[0] !== null &&
          typeof optionalParams[0] !== 'string'
        ) {
          fields = optionalParams[0] as Record<string, unknown>;
        }
      }

      this.pino[level](
        withContext({
          ...fields,
          ...(contextName ? { context: contextName } : {}),
        }),
        msg,
      );
    } catch {
      // Never let logging crash the process.
      try {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ level: 'error', event: 'logger.failure' }));
      } catch {
        // ignore
      }
    }
  }
}

export function createAppLogger(): StructuredNestLogger {
  return new StructuredNestLogger('Bootstrap');
}

/** Convenience structured event helper for services. */
export function logEvent(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
  message?: string,
): void {
  getPinoLogger()[level](withContext({ event, ...fields }), message ?? event);
}

/** Fallback console logger for tests that need Nest ConsoleLogger shape. */
export function createFallbackConsoleLogger(): ConsoleLogger {
  return new ConsoleLogger();
}
