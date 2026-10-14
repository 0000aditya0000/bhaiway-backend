import { recordExternalFailure } from './metrics.registry';
import { createBackgroundTraceIds, getRequestContext } from './request-context';
import { logEvent } from './structured-logger';

/**
 * Safe structured diagnostics for Redis / FCM / SMTP / payment / KYC HTTP.
 * Never pass payloads, signatures, OTPs, or SQL parameters.
 */
export function logExternalFailure(input: {
  service: string;
  operation: string;
  durationMs?: number;
  errorName?: string;
  message?: string;
  referenceId?: string;
  providerEventId?: string;
  verificationOutcome?: 'accepted' | 'rejected' | 'error';
}): void {
  recordExternalFailure();
  const ctx = getRequestContext();
  const bg =
    ctx?.requestId != null ? undefined : createBackgroundTraceIds(input.service);

  logEvent(
    'error',
    'external.service.failed',
    {
      externalService: input.service,
      operation: input.operation,
      durationMs: input.durationMs,
      errorName: input.errorName,
      message: input.message?.slice(0, 240),
      referenceId: input.referenceId,
      providerEventId: input.providerEventId,
      verificationOutcome: input.verificationOutcome,
      requestId: ctx?.requestId ?? bg?.requestId,
      correlationId: ctx?.correlationId ?? bg?.correlationId,
    },
    `${input.service}.${input.operation} failed`,
  );
}

export function logExternalSuccess(input: {
  service: string;
  operation: string;
  durationMs?: number;
  referenceId?: string;
}): void {
  logEvent(
    'info',
    'external.service.ok',
    {
      externalService: input.service,
      operation: input.operation,
      durationMs: input.durationMs,
      referenceId: input.referenceId,
    },
    `${input.service}.${input.operation} ok`,
  );
}
