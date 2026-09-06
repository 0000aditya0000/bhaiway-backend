import type { PushSendRequest, PushSendResult } from '../notifications.types';

export interface NotificationProvider {
  readonly name: string;
  isEnabled(): boolean;
  send(request: PushSendRequest): Promise<PushSendResult>;
}
