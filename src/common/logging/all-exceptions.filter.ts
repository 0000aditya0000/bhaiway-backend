import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { captureExceptionOptional } from './sentry.optional';
import { normalizeRoutePath, redactSensitive } from './redaction';
import { getRequestContext } from './request-context';
import { getPinoLogger } from './structured-logger';

/**
 * Centralized exception logging without changing Nest/API error contracts.
 * Client errors → warn; unexpected → error + optional Sentry.
 * Stack traces stay server-side only.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = getPinoLogger().child({ context: 'ExceptionFilter' });

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<
      Request & {
        user?: { userId?: string };
        route?: { path?: string };
      }
    >();

    const ctx = getRequestContext();
    const requestId = ctx?.requestId;
    const correlationId = ctx?.correlationId;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let responseBody: string | Record<string, unknown> = {
      statusCode: status,
      message: 'Internal server error',
      error: 'Internal Server Error',
    };
    let errorCode: string | undefined;
    let errorName =
      exception instanceof Error ? exception.name : 'UnknownError';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exResponse = exception.getResponse();
      if (typeof exResponse === 'string') {
        responseBody = {
          statusCode: status,
          message: exResponse,
          error: exception.name,
        };
      } else if (typeof exResponse === 'object' && exResponse !== null) {
        responseBody = exResponse as Record<string, unknown>;
        const code = (exResponse as { code?: unknown }).code;
        if (typeof code === 'string') {
          errorCode = code;
        }
      }
      errorName = exception.name;
    }

    const route = normalizeRoutePath(
      req.originalUrl ?? req.url ?? '/',
      req.route?.path,
      req.baseUrl,
    );
    const method = req.method ?? 'UNKNOWN';

    try {
      // Completion line is owned by HttpRequestLoggingInterceptor (once).
      // This filter only adds server-side diagnostics for unexpected 5xx.
      if (status >= 500) {
        const stack =
          exception instanceof Error ? exception.stack : undefined;
        this.logger.error(
          {
            event: 'http.exception.unhandled',
            requestId,
            correlationId,
            method,
            route,
            statusCode: status,
            errorCode,
            errorName,
            message:
              exception instanceof Error
                ? exception.message
                : 'Unexpected error',
            // Server-side only — never attached to responseBody.
            stack,
            userId: req.user?.userId ?? ctx?.userId,
            // Ensure we never echo raw exception payloads with secrets.
            safeContext: redactSensitive({ errorCode, errorName }),
          },
          `Unhandled ${errorName} on ${method} ${route}`,
        );
        captureExceptionOptional(exception, {
          requestId,
          correlationId,
          method,
          route,
          statusCode: status,
          errorCode,
        });
      }
    } catch {
      // Logging must never break error responses.
    }

    if (!res.headersSent) {
      if (requestId) {
        res.setHeader('X-Request-Id', requestId);
      }
      if (correlationId) {
        res.setHeader('X-Correlation-Id', correlationId);
      }
      res.status(status).json(responseBody);
    }
  }
}
