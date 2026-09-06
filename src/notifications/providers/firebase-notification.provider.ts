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
import {
  isLikelyPemPrivateKey,
  normalizeFirebasePrivateKey,
  readFirebaseConfigPresence,
} from './firebase-config.util';

@Injectable()
export class FirebaseNotificationProvider
  implements NotificationProvider, OnModuleInit
{
  readonly name = NotificationProviderName.FCM;
  private readonly logger = new Logger(FirebaseNotificationProvider.name);
  private enabled = false;
  private messaging: Messaging | null = null;
  private disableReason: string | null = 'NOT_INITIALIZED';

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const projectId = this.configService
      .get<string>('FIREBASE_PROJECT_ID')
      ?.trim();
    const clientEmail = this.configService
      .get<string>('FIREBASE_CLIENT_EMAIL')
      ?.trim();
    const privateKeyRaw = this.configService.get<string>('FIREBASE_PRIVATE_KEY');

    const presence = readFirebaseConfigPresence({
      projectId,
      clientEmail,
      privateKey: privateKeyRaw,
    });

    this.logger.log(
      `[NOTIFICATIONS] provider=firebase project configured=${presence.projectIdConfigured} client email configured=${presence.clientEmailConfigured} private key configured=${presence.privateKeyConfigured}`,
    );

    if (
      !presence.projectIdConfigured ||
      !presence.clientEmailConfigured ||
      !presence.privateKeyConfigured
    ) {
      const missing: string[] = [];
      if (!presence.projectIdConfigured) missing.push('FIREBASE_PROJECT_ID');
      if (!presence.clientEmailConfigured) missing.push('FIREBASE_CLIENT_EMAIL');
      if (!presence.privateKeyConfigured) missing.push('FIREBASE_PRIVATE_KEY');
      this.disableReason = `MISSING_CONFIG:${missing.join(',')}`;
      this.enabled = false;
      this.messaging = null;
      this.logger.warn(
        `[NOTIFICATIONS] firebase configured=false initialization=skipped reason=${this.disableReason}`,
      );
      return;
    }

    try {
      const privateKey = normalizeFirebasePrivateKey(privateKeyRaw!);
      if (!isLikelyPemPrivateKey(privateKey)) {
        this.disableReason = 'INVALID_PRIVATE_KEY_FORMAT';
        this.enabled = false;
        this.messaging = null;
        this.logger.error(
          '[NOTIFICATIONS] firebase configured=false initialization=failure reason=INVALID_PRIVATE_KEY_FORMAT (expected PEM BEGIN PRIVATE KEY)',
        );
        return;
      }

      const app: App =
        getApps().length > 0
          ? getApps()[0]!
          : initializeApp({
              credential: cert({
                projectId: projectId!,
                clientEmail: clientEmail!,
                privateKey,
              }),
            });
      this.messaging = getMessaging(app);
      this.enabled = true;
      this.disableReason = null;
      this.logger.log(
        '[NOTIFICATIONS] firebase configured=true initialization=success',
      );
    } catch (error) {
      this.enabled = false;
      this.messaging = null;
      const message = error instanceof Error ? error.message : String(error);
      // Avoid echoing key material if an error message ever included it.
      const safeMessage = message
        .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[REDACTED_PEM]')
        .slice(0, 300);
      this.disableReason = `INIT_FAILED:${safeMessage}`;
      this.logger.error(
        `[NOTIFICATIONS] firebase configured=false initialization=failure reason=${safeMessage}`,
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled && this.messaging !== null;
  }

  getDisableReason(): string | null {
    return this.disableReason;
  }

  async send(request: PushSendRequest): Promise<PushSendResult> {
    if (!this.messaging) {
      return {
        ok: false,
        permanent: false,
        reason: this.disableReason ?? 'FCM_NOT_CONFIGURED',
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
