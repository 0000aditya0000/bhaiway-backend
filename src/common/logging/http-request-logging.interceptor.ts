import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';

import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  RESPONSE_CORRELATION_ID_HEADER,
  RESPONSE_REQUEST_ID_HEADER,
} from './logging.constants';
import { recordHttpMetric } from './metrics.registry';
import { normalizeRoutePath } from './redaction';
import {
  resolveOrCreateTraceId,
  runWithRequestContext,
  updateRequestContext,
  validateTraceId,
} from './request-context';
import { getPinoLogger } from './structured-logger';

type ExpressLikeRequest = {
  method?: string;
  originalUrl?: string;
  url?: string;
  baseUrl?: string;
  route?: { path?: string };
  headers?: Record<string, string | string[] | undefined>;
  user?: { userId?: string };
};

type ExpressLikeResponse = {
  statusCode?: number;
  setHeader?: (name: string, value: string) => void;
  headersSent?: boolean;
};

/**
 * Sole HTTP request-completion logger for BhaiWay.
 * Do not register a second request logger (e.g. nestjs-pino HTTP middleware).
 *
 * Never logs bodies, Authorization, cookies, tokens, OTPs, or query strings.
 */
@Injectable()
export class HttpRequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = getPinoLogger().child({ context: 'HTTP' });

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<ExpressLikeRequest>();
    const res = http.getResponse<ExpressLikeResponse>();

    const started = Date.now();
    const requestResolved = resolveOrCreateTraceId(
      req.headers?.[REQUEST_ID_HEADER],
    );
    const requestId = requestResolved.id;
    const correlationId =
      validateTraceId(req.headers?.[CORRELATION_ID_HEADER]) ?? requestId;

    try {
      res.setHeader?.(RESPONSE_REQUEST_ID_HEADER, requestId);
      res.setHeader?.(RESPONSE_CORRELATION_ID_HEADER, correlationId);
    } catch {
      // Never fail the request because of logging setup.
    }

    const store = {
      requestId,
      correlationId,
      method: req.method,
      userId:
        typeof req.user?.userId === 'string' && req.user.userId.length > 0
          ? req.user.userId
          : undefined,
    };

    // Bind ALS for the full RxJS subscription so async handlers see requestId.
    return new Observable((subscriber) => {
      const subscription = runWithRequestContext(store, () =>
        next
          .handle()
          .pipe(
            catchError((err: unknown) => {
              try {
                if (err instanceof HttpException) {
                  res.statusCode = err.getStatus();
                } else if (!res.statusCode || res.statusCode < 400) {
                  res.statusCode = 500;
                }
              } catch {
                // ignore
              }
              return throwError(() => err);
            }),
            finalize(() => {
              try {
                const method = req.method ?? 'UNKNOWN';
                const route = normalizeRoutePath(
                  req.originalUrl ?? req.url ?? '/',
                  req.route?.path,
                  req.baseUrl,
                );
                updateRequestContext({ route, method });

                const status = res.statusCode ?? 0;
                const durationMs = Date.now() - started;
                const userId =
                  typeof req.user?.userId === 'string' &&
                  req.user.userId.length > 0
                    ? req.user.userId
                    : store.userId;

                const level =
                  status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

                this.logger[level](
                  {
                    event: 'http.request.completed',
                    requestId,
                    correlationId,
                    method,
                    route,
                    statusCode: status,
                    durationMs,
                    userId: userId ?? 'anonymous',
                    outcome:
                      status >= 500
                        ? 'server_error'
                        : status >= 400
                          ? 'client_error'
                          : 'success',
                  },
                  `${method} ${route} ${status} ${durationMs}ms`,
                );

                recordHttpMetric({
                  route,
                  method,
                  statusCode: status,
                  durationMs,
                });
              } catch {
                // Swallow logging errors — never crash the request.
              }
            }),
          )
          .subscribe({
            next: (value) => subscriber.next(value),
            error: (err) => subscriber.error(err),
            complete: () => subscriber.complete(),
          }),
      );

      return () => subscription.unsubscribe();
    });
  }
}
