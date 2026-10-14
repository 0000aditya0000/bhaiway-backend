import { redactSensitive } from './redaction';

let sentryEnabled = false;

/**
 * Opt-in Sentry. Never throws; never required for startup.
 * Set SENTRY_DSN to enable. Do not commit DSNs.
 */
export function initOptionalSentry(): void {
  const dsn = (process.env.SENTRY_DSN ?? '').trim();
  if (!dsn) {
    return;
  }
  try {
    // Lazy require so missing/optional install never blocks boot when unused.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require('@sentry/node') as typeof import('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV ?? 'development',
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0'),
      beforeSend(event) {
        try {
          if (event.request) {
            delete event.request.data;
            delete event.request.cookies;
            if (event.request.headers) {
              const headers = { ...event.request.headers };
              for (const key of Object.keys(headers)) {
                const lower = key.toLowerCase();
                if (
                  lower === 'authorization' ||
                  lower === 'cookie' ||
                  lower.includes('signature') ||
                  lower.includes('api-key')
                ) {
                  headers[key] = '[REDACTED]';
                }
              }
              event.request.headers = headers;
            }
          }
          if (event.extra) {
            event.extra = redactSensitive(event.extra) as typeof event.extra;
          }
        } catch {
          // drop enrichment failures
        }
        return event;
      },
    });
    sentryEnabled = true;
  } catch {
    sentryEnabled = false;
  }
}

export function captureExceptionOptional(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  if (!sentryEnabled) {
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require('@sentry/node') as typeof import('@sentry/node');
    Sentry.withScope((scope) => {
      if (context) {
        const safe = redactSensitive(context) as Record<string, unknown>;
        for (const [k, v] of Object.entries(safe)) {
          scope.setExtra(k, v);
        }
      }
      Sentry.captureException(error);
    });
  } catch {
    // ignore
  }
}

export function isSentryEnabled(): boolean {
  return sentryEnabled;
}
