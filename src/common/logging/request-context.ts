import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

import {
  MAX_TRACE_ID_LENGTH,
  TRACE_ID_PATTERN,
} from './logging.constants';

export interface RequestContextStore {
  requestId: string;
  correlationId: string;
  userId?: string;
  method?: string;
  route?: string;
}

const als = new AsyncLocalStorage<RequestContextStore>();

export function validateTraceId(
  raw: string | string[] | undefined,
): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (
    trimmed.length < 8 ||
    trimmed.length > MAX_TRACE_ID_LENGTH ||
    !TRACE_ID_PATTERN.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

export function resolveOrCreateTraceId(
  headerValue: string | string[] | undefined,
): { id: string; acceptedClientId: boolean } {
  const validated = validateTraceId(headerValue);
  if (validated) {
    return { id: validated, acceptedClientId: true };
  }
  return { id: randomUUID(), acceptedClientId: false };
}

export function runWithRequestContext<T>(
  store: RequestContextStore,
  fn: () => T,
): T {
  return als.run(store, fn);
}

export function getRequestContext(): RequestContextStore | undefined {
  return als.getStore();
}

export function updateRequestContext(
  patch: Partial<RequestContextStore>,
): void {
  const store = als.getStore();
  if (!store) {
    return;
  }
  Object.assign(store, patch);
}

/** For webhooks/jobs outside HTTP: mint a fresh correlation id. */
export function createBackgroundTraceIds(prefix = 'bg'): {
  requestId: string;
  correlationId: string;
} {
  const id = `${prefix}_${randomUUID()}`;
  return { requestId: id, correlationId: id };
}
