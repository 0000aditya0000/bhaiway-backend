import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';

const REQUEST_ID_HEADER = 'x-request-id';
const RESPONSE_ID_HEADER = 'X-Request-Id';

/**
 * Safe HTTP access log: method, path, status, duration, request id, user id.
 * Never logs bodies, Authorization, tokens, OTPs, or other secrets.
 */
@Injectable()
export class HttpRequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<{
      method?: string;
      originalUrl?: string;
      url?: string;
      headers?: Record<string, string | string[] | undefined>;
      user?: { userId?: string };
    }>();
    const res = http.getResponse<{
      statusCode?: number;
      setHeader?: (name: string, value: string) => void;
    }>();

    const started = Date.now();
    let requestId = 'unknown';

    try {
      requestId = this.resolveRequestId(req.headers?.[REQUEST_ID_HEADER]);
      res.setHeader?.(RESPONSE_ID_HEADER, requestId);
    } catch {
      // Never fail the request because of logging setup.
    }

    return next.handle().pipe(
      finalize(() => {
        try {
          const method = req.method ?? 'UNKNOWN';
          const path = this.safePath(req.originalUrl ?? req.url ?? '/');
          const status = res.statusCode ?? 0;
          const durationMs = Date.now() - started;
          const userId =
            typeof req.user?.userId === 'string' && req.user.userId.length > 0
              ? req.user.userId
              : 'anonymous';

          this.logger.log(
            `req=${requestId} ${method} ${path} → ${status} ${durationMs}ms user=${userId}`,
          );
        } catch {
          // Swallow logging errors.
        }
      }),
    );
  }

  private resolveRequestId(
    headerValue: string | string[] | undefined,
  ): string {
    const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim().slice(0, 128);
    }
    return randomUUID();
  }

  /** Path only — strip query string so tokens in query never appear in logs. */
  private safePath(url: string): string {
    const q = url.indexOf('?');
    return q >= 0 ? url.slice(0, q) : url;
  }
}
