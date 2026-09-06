import { NotificationType } from './enums/notification.enums';

export type NotificationDataValue = string | number | boolean | null;

export type NotificationDataPayload = Record<string, NotificationDataValue> & {
  type: NotificationType | string;
};

export interface EnqueueNotificationInput {
  recipientUserId: string;
  type: NotificationType;
  title: string;
  body: string;
  data: NotificationDataPayload;
  idempotencyKey: string;
}

export interface PushSendRequest {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
  sound?: string;
}

export type PushSendResult =
  | {
      ok: true;
      providerMessageId: string;
    }
  | {
      ok: false;
      permanent: boolean;
      reason: string;
    };

export const NOTIFICATION_SOUND = 'default';

export const NOTIFICATION_PROVIDER = Symbol('NOTIFICATION_PROVIDER');
