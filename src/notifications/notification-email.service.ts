import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { IsNull, LessThanOrEqual, Repository } from 'typeorm';

import { SmtpMailService } from '../email/smtp-mail.service';
import { User } from '../users/entities/user.entity';
import { NotificationEmailDelivery } from './entities/notification-email-delivery.entity';
import { Notification } from './entities/notification.entity';
import { NotificationEmailDeliveryStatus } from './enums/notification-email.enums';
import { buildNotificationEmailContent } from './notification-email.templates';

const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 5_000;
const PENDING_POLL_MS = 20_000;

@Injectable()
export class NotificationEmailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationEmailService.name);
  private readonly inFlight = new Map<string, Promise<void>>();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly smtpMailService: SmtpMailService,
    @InjectRepository(NotificationEmailDelivery)
    private readonly deliveryRepository: Repository<NotificationEmailDelivery>,
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  onModuleInit(): void {
    this.pollTimer = setInterval(() => {
      void this.dispatchPending().catch((error) => {
        this.logger.warn(
          `Email pending poll failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, PENDING_POLL_MS);
    this.pollTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Ensure a delivery row exists and schedule async send.
   * Safe to call repeatedly — unique on notification_id.
   */
  async ensureDeliveryQueued(notificationId: string): Promise<void> {
    try {
      const existing = await this.deliveryRepository.findOne({
        where: { notificationId },
      });
      if (!existing) {
        await this.deliveryRepository.save(
          this.deliveryRepository.create({
            id: randomUUID(),
            notificationId,
            status: NotificationEmailDeliveryStatus.PENDING,
            recipientEmail: null,
            skipReason: null,
            attemptCount: 0,
            nextAttemptAt: null,
            sentAt: null,
            failedAt: null,
            failureReason: null,
          }),
        );
      } else if (
        existing.status === NotificationEmailDeliveryStatus.SENT ||
        existing.status === NotificationEmailDeliveryStatus.SKIPPED ||
        (existing.status === NotificationEmailDeliveryStatus.FAILED &&
          existing.attemptCount >= MAX_ATTEMPTS)
      ) {
        return;
      }

      this.scheduleDeliver(notificationId);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        this.scheduleDeliver(notificationId);
        return;
      }
      this.logger.warn(
        `ensureDeliveryQueued failed notification=${notificationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  scheduleDeliver(notificationId: string): void {
    setImmediate(() => {
      void this.deliver(notificationId);
    });
  }

  async dispatchPending(limit = 25): Promise<void> {
    const now = new Date();
    const rows = await this.deliveryRepository.find({
      where: [
        {
          status: NotificationEmailDeliveryStatus.PENDING,
          nextAttemptAt: IsNull(),
        },
        {
          status: NotificationEmailDeliveryStatus.PENDING,
          nextAttemptAt: LessThanOrEqual(now),
        },
        {
          status: NotificationEmailDeliveryStatus.FAILED,
          nextAttemptAt: LessThanOrEqual(now),
        },
      ],
      take: limit,
      order: { createdAt: 'ASC' },
    });

    for (const row of rows) {
      if (row.attemptCount >= MAX_ATTEMPTS) {
        continue;
      }
      await this.deliver(row.notificationId);
    }
  }

  async deliver(notificationId: string): Promise<void> {
    const existing = this.inFlight.get(notificationId);
    if (existing) {
      await existing;
      return;
    }

    const run = this.runDeliver(notificationId).finally(() => {
      this.inFlight.delete(notificationId);
    });
    this.inFlight.set(notificationId, run);
    await run;
  }

  private async runDeliver(notificationId: string): Promise<void> {
    try {
      let delivery = await this.deliveryRepository.findOne({
        where: { notificationId },
      });
      if (!delivery) {
        await this.ensureDeliveryQueued(notificationId);
        delivery = await this.deliveryRepository.findOne({
          where: { notificationId },
        });
      }
      if (!delivery) {
        return;
      }

      if (
        delivery.status === NotificationEmailDeliveryStatus.SENT ||
        delivery.status === NotificationEmailDeliveryStatus.SKIPPED
      ) {
        return;
      }
      if (
        delivery.status === NotificationEmailDeliveryStatus.FAILED &&
        delivery.attemptCount >= MAX_ATTEMPTS
      ) {
        return;
      }
      if (
        delivery.nextAttemptAt &&
        delivery.nextAttemptAt.getTime() > Date.now()
      ) {
        return;
      }

      const notification = await this.notificationRepository.findOne({
        where: { id: notificationId },
      });
      if (!notification) {
        delivery.status = NotificationEmailDeliveryStatus.SKIPPED;
        delivery.skipReason = 'notification_missing';
        await this.deliveryRepository.save(delivery);
        this.logger.log(
          `Email skipped notification=${notificationId} status=SKIPPED skipReason=notification_missing`,
        );
        return;
      }

      const user = await this.userRepository.findOne({
        where: { id: notification.recipientUserId },
      });
      if (!user?.email?.trim() || !user.emailVerified) {
        delivery.status = NotificationEmailDeliveryStatus.SKIPPED;
        delivery.skipReason = !user?.email?.trim()
          ? 'email_missing'
          : 'email_unverified';
        delivery.recipientEmail = null;
        await this.deliveryRepository.save(delivery);
        this.logger.log(
          `Email skipped notification=${notificationId} status=SKIPPED skipReason=${delivery.skipReason} recipientUser=${notification.recipientUserId}`,
        );
        return;
      }

      // Recheck verification immediately before provider call (queued delay / revocation).
      const recheck = await this.userRepository.findOne({
        where: { id: notification.recipientUserId },
      });
      if (!recheck?.email?.trim() || !recheck.emailVerified) {
        delivery.status = NotificationEmailDeliveryStatus.SKIPPED;
        delivery.skipReason = !recheck?.email?.trim()
          ? 'email_missing'
          : 'email_unverified';
        delivery.recipientEmail = null;
        await this.deliveryRepository.save(delivery);
        this.logger.log(
          `Email skipped notification=${notificationId} status=SKIPPED skipReason=${delivery.skipReason} recipientUser=${notification.recipientUserId}`,
        );
        return;
      }

      const recipientEmail = recheck.email.trim().toLowerCase();
      delivery.recipientEmail = recipientEmail;
      delivery.attemptCount += 1;

      try {
        const content = buildNotificationEmailContent(notification);
        await this.smtpMailService.sendEmail({
          to: recipientEmail,
          subject: content.subject,
          html: content.html,
          text: content.text,
        });

        delivery.status = NotificationEmailDeliveryStatus.SENT;
        delivery.sentAt = new Date();
        delivery.failedAt = null;
        delivery.failureReason = null;
        delivery.nextAttemptAt = null;
        await this.deliveryRepository.save(delivery);
        this.logger.log(
          `Email sent notification=${notificationId} status=SENT recipientUser=${notification.recipientUserId}`,
        );
      } catch (error) {
        const reason =
          error instanceof Error ? error.message.slice(0, 500) : String(error);
        const terminal = delivery.attemptCount >= MAX_ATTEMPTS;
        delivery.status = terminal
          ? NotificationEmailDeliveryStatus.FAILED
          : NotificationEmailDeliveryStatus.PENDING;
        delivery.failedAt = terminal ? new Date() : delivery.failedAt;
        delivery.failureReason = reason;
        delivery.nextAttemptAt = new Date(
          Date.now() + RETRY_BASE_MS * 2 ** Math.min(delivery.attemptCount, 4),
        );
        await this.deliveryRepository.save(delivery);
        this.logger.warn(
          `Email delivery failed notification=${notificationId} status=${delivery.status} attempt=${delivery.attemptCount} maxAttempts=${MAX_ATTEMPTS} nextAttemptAt=${delivery.nextAttemptAt?.toISOString() ?? 'none'}: ${reason}`,
        );
      }
    } catch (error) {
      if (this.isForeignKeyViolation(error)) {
        this.logger.warn(
          `Email delivery skipped notification=${notificationId}: notification row is gone`,
        );
        return;
      }
      throw error;
    } finally {
      this.inFlight.delete(notificationId);
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    );
  }

  private isForeignKeyViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23503'
    );
  }
}
