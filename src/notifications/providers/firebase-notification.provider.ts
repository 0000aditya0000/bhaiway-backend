import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';

import { NotificationProviderName } from '../enums/notification.enums';
import {
  NOTIFICATION_SOUND,
  type PushSendRequest,
  type PushSendResult,
} from '../notifications.types';
import type { NotificationProvider } from './notification.provider';

@Injectable()
export class FirebaseNotificationProvider
  implements NotificationProvider, OnModuleInit
{
  readonly name = NotificationProviderName.FCM;
  private readonly logger = new Logger(FirebaseNotificationProvider.name);
  private enabled = false;
  private messaging: Messaging | null = null;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const projectId = this.configService.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.configService.get<string>('FIREBASE_CLIENT_EMAIL');
    const privateKeyRaw = this.configService.get<string>('FIREBASE_PRIVATE_KEY');

    if (!projectId || !clientEmail || !privateKeyRaw) {
      this.logger.warn(
        'Firebase FCM credentials not configured; push delivery disabled',
      );
      this.enabled = false;
      return;
    }

    try {
      const privateKey = privateKeyRaw.replace(/\\n/g, '\n');
      const app: App =
        getApps().length > 0
          ? getApps()[0]!
          : initializeApp({
              credential: cert({
                projectId,
                clientEmail,
                privateKey,
              }),
            });
      this.messaging = getMessaging(app);
      this.enabled = true;
      this.logger.log('Firebase FCM provider initialized');
    } catch (error) {
      this.enabled = false;
      this.logger.error(
        `Firebase FCM init failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled && this.messaging !== null;
  }

  async send(request: PushSendRequest): Promise<PushSendResult> {
    if (!this.messaging) {
      return {
        ok: false,
        permanent: false,
        reason: 'FCM_NOT_CONFIGURED',
      };
    }

    try {
      const messageId = await this.messaging.send({
        token: request.token,
        notification: {
          title: request.title,
          body: request.body,
        },
        data: request.data,
        android: {
          priority: 'high',
          notification: {
            sound: request.sound ?? NOTIFICATION_SOUND,
            channelId: 'bhaiway_default',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: request.sound ?? NOTIFICATION_SOUND,
              badge: 1,
            },
          },
        },
      });

      return {
        ok: true,
        providerMessageId: messageId,
      };
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: string }).code ?? '')
          : '';
      const reason = error instanceof Error ? error.message : String(error);
      const permanent =
        code.includes('registration-token-not-registered') ||
        code.includes('invalid-registration-token') ||
        code.includes('invalid-argument') ||
        /not.?registered|invalid.?token/i.test(reason);

      return {
        ok: false,
        permanent,
        reason: code || reason,
      };
    }
  }
}
