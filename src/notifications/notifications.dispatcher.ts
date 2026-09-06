import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotificationDevice } from './entities/notification-device.entity';
import { Notification } from './entities/notification.entity';
import {
  NotificationProviderName,
  NotificationStatus,
} from './enums/notification.enums';
import { stringifyNotificationData } from './notifications.helpers';
import {
  NOTIFICATION_PROVIDER,
  NOTIFICATION_SOUND,
  type PushSendResult,
} from './notifications.types';
import type { NotificationProvider } from './providers/notification.provider';

const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 5_000;

@Injectable()
export class NotificationsDispatcher {
  private readonly logger = new Logger(NotificationsDispatcher.name);
  private readonly inFlight = new Set<string>();

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    @InjectRepository(NotificationDevice)
    private readonly deviceRepository: Repository<NotificationDevice>,
    @Inject(NOTIFICATION_PROVIDER)
    private readonly provider: NotificationProvider,
  ) {}

  scheduleDispatch(notificationId: string): void {
    setImmediate(() => {
      void this.dispatch(notificationId);
    });
  }

  async dispatch(notificationId: string): Promise<void> {
    if (this.inFlight.has(notificationId)) {
      return;
    }
    this.inFlight.add(notificationId);

    try {
      const notification = await this.notificationRepository.findOne({
        where: { id: notificationId },
      });
      if (!notification) {
        return;
      }
      if (notification.status === NotificationStatus.SENT) {
        return;
      }
      if (
        notification.status === NotificationStatus.FAILED &&
        notification.attemptCount >= MAX_ATTEMPTS
      ) {
        return;
      }
      if (
        notification.nextAttemptAt &&
        notification.nextAttemptAt.getTime() > Date.now()
      ) {
        return;
      }

      await this.deliver(notification);
    } catch (error) {
      this.logger.warn(
        `Dispatch failed notification=${notificationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.inFlight.delete(notificationId);
    }
  }

  async dispatchPending(limit = 50): Promise<number> {
    const now = new Date();
    const pending = await this.notificationRepository
      .createQueryBuilder('n')
      .where('n.status = :pending', { pending: NotificationStatus.PENDING })
      .andWhere('(n.next_attempt_at IS NULL OR n.next_attempt_at <= :now)', {
        now,
      })
      .andWhere('n.attempt_count < :maxAttempts', { maxAttempts: MAX_ATTEMPTS })
      .orderBy('n.created_at', 'ASC')
      .take(limit)
      .getMany();

    let count = 0;
    for (const row of pending) {
      await this.dispatch(row.id);
      count += 1;
    }
    return count;
  }

  private async deliver(notification: Notification): Promise<void> {
    const devices = await this.deviceRepository.find({
      where: {
        userId: notification.recipientUserId,
        isActive: true,
      },
    });

    notification.attemptCount += 1;
    notification.provider =
      (this.provider.name as NotificationProviderName) ??
      NotificationProviderName.FCM;

    if (!this.provider.isEnabled()) {
      await this.markFailed(
        notification,
        'PROVIDER_DISABLED',
        /*retry*/ true,
      );
      return;
    }

    if (devices.length === 0) {
      // No devices yet — keep PENDING for a short retry window so late
      // registration can still receive the push, then settle as SENT with note.
      if (notification.attemptCount >= 3) {
        notification.status = NotificationStatus.SENT;
        notification.sentAt = new Date();
        notification.failureReason = 'NO_ACTIVE_DEVICES';
        notification.nextAttemptAt = null;
        await this.notificationRepository.save(notification);
        return;
      }
      await this.markFailed(notification, 'NO_ACTIVE_DEVICES', true);
      return;
    }

    const data = stringifyNotificationData({
      ...notification.data,
      type: notification.type,
      notificationId: notification.id,
    });

    const results: PushSendResult[] = [];
    let anySuccess = false;
    let lastTransientReason: string | null = null;
    let providerMessageId: string | null = null;

    for (const device of devices) {
      try {
        const result = await this.provider.send({
          token: device.token,
          title: notification.title,
          body: notification.body,
          data,
          sound: NOTIFICATION_SOUND,
        });
        results.push(result);

        if (result.ok) {
          anySuccess = true;
          providerMessageId = result.providerMessageId;
        } else if (result.permanent) {
          device.isActive = false;
          await this.deviceRepository.save(device);
          this.logger.warn(
            `Deactivated invalid FCM token device=${device.id} reason=${result.reason}`,
          );
        } else {
          lastTransientReason = result.reason;
        }
      } catch (error) {
        lastTransientReason =
          error instanceof Error ? error.message : String(error);
        results.push({
          ok: false,
          permanent: false,
          reason: lastTransientReason,
        });
      }
    }

    if (anySuccess) {
      notification.status = NotificationStatus.SENT;
      notification.sentAt = new Date();
      notification.failedAt = null;
      notification.failureReason = null;
      notification.providerMessageId = providerMessageId;
      notification.nextAttemptAt = null;
      await this.notificationRepository.save(notification);
      return;
    }

    const allPermanent =
      results.length > 0 && results.every((r) => !r.ok && r.permanent);
    if (allPermanent) {
      await this.markFailed(notification, 'ALL_TOKENS_INVALID', false);
      return;
    }

    await this.markFailed(
      notification,
      lastTransientReason ?? 'DELIVERY_FAILED',
      notification.attemptCount < MAX_ATTEMPTS,
    );
  }

  private async markFailed(
    notification: Notification,
    reason: string,
    retry: boolean,
  ): Promise<void> {
    notification.failureReason = reason.slice(0, 500);
    notification.failedAt = new Date();

    if (retry && notification.attemptCount < MAX_ATTEMPTS) {
      notification.status = NotificationStatus.PENDING;
      const delay =
        RETRY_BASE_MS * Math.pow(2, Math.max(0, notification.attemptCount - 1));
      notification.nextAttemptAt = new Date(Date.now() + delay);
    } else {
      notification.status = NotificationStatus.FAILED;
      notification.nextAttemptAt = null;
    }

    await this.notificationRepository.save(notification);
  }
}
