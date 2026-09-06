import type { PushSendRequest, PushSendResult } from '../notifications.types';

export interface NotificationProvider {
  readonly name: string;
  isEnabled(): boolean;
  /** Present when isEnabled() is false — safe, non-secret reason for ops. */
  getDisableReason?(): string | null;
  send(request: PushSendRequest): Promise<PushSendResult>;
}
