import { Injectable } from '@nestjs/common';

import { logEvent } from './structured-logger';

export type AuditActorCategory =
  | 'USER'
  | 'ADMIN'
  | 'SYSTEM'
  | 'WEBHOOK'
  | 'ANONYMOUS';

export interface AuditEventInput {
  action: string;
  outcome: 'SUCCESS' | 'FAILURE' | 'DENIED' | 'INFO';
  actorCategory: AuditActorCategory;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  /** Non-sensitive metadata only. */
  metadata?: Record<string, unknown>;
}

/**
 * Structured audit events for ops/security review.
 *
 * Not a replacement for financial ledger or durable coupon_audit_logs.
 * Prefer durable DB audit/outbox for money-critical mutations; this emits
 * structured logs correlated by requestId when an HTTP context exists.
 */
@Injectable()
export class AuditLogger {
  emit(input: AuditEventInput): void {
    logEvent(
      input.outcome === 'FAILURE' || input.outcome === 'DENIED'
        ? 'warn'
        : 'info',
      'audit.event',
      {
        auditAction: input.action,
        outcome: input.outcome,
        actorCategory: input.actorCategory,
        actorId: input.actorId,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: input.metadata,
      },
      `audit ${input.action} ${input.outcome}`,
    );
  }
}
