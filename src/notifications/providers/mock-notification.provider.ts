import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { NotificationProviderName } from '../enums/notification.enums';
import type { PushSendRequest, PushSendResult } from '../notifications.types';
import type { NotificationProvider } from './notification.provider';

@Injectable()
export class MockNotificationProvider implements NotificationProvider {
  readonly name = NotificationProviderName.MOCK;

  /** Tokens that simulate permanent FCM invalidity in tests. */
  permanentInvalidTokens = new Set<string>();

  /** When true, every send fails as transient. */
  failTransient = false;

  /** When true, every send throws. */
  throwOnSend = false;

  sent: PushSendRequest[] = [];

  isEnabled(): boolean {
    return true;
  }

  reset(): void {
    this.permanentInvalidTokens.clear();
    this.failTransient = false;
    this.throwOnSend = false;
    this.sent = [];
  }

  async send(request: PushSendRequest): Promise<PushSendResult> {
    if (this.throwOnSend) {
      throw new Error('Mock FCM provider forced failure');
    }

    if (this.permanentInvalidTokens.has(request.token)) {
      return {
        ok: false,
        permanent: true,
        reason: 'UNREGISTERED',
      };
    }

    if (this.failTransient) {
      return {
        ok: false,
        permanent: false,
        reason: 'TRANSIENT_UNAVAILABLE',
      };
    }

    this.sent.push(request);
    return {
      ok: true,
      providerMessageId: `mock-${randomUUID()}`,
    };
  }
}
