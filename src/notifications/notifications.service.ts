import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';

import { UserProfile } from '../users/entities/user-profile.entity';
import { isPlatformUserId } from '../wallet/platform-wallet.constants';
import {
  NotificationDeviceResponseDto,
  RegisterNotificationDeviceDto,
} from './dto/register-device.dto';
import { NotificationDevice } from './entities/notification-device.entity';
import { Notification } from './entities/notification.entity';
import {
  NotificationProviderName,
  NotificationStatus,
  NotificationType,
} from './enums/notification.enums';
import { NotificationsDispatcher } from './notifications.dispatcher';
import {
  assuredPublishedKey,
  bookingCancelledKey,
  bookingConfirmedKey,
  bookingReceivedKey,
  chatMessageKey,
  commuteCancelledKey,
  commuteConfirmedKey,
  commuteRequestedKey,
  formatInrAmount,
  redactToken,
  walletCreditedKey,
} from './notifications.helpers';
import type { EnqueueNotificationInput } from './notifications.types';

const PENDING_POLL_MS = 15_000;

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dispatcher: NotificationsDispatcher,
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    @InjectRepository(NotificationDevice)
    private readonly deviceRepository: Repository<NotificationDevice>,
    @InjectRepository(UserProfile)
    private readonly profileRepository: Repository<UserProfile>,
  ) {}

  onModuleInit(): void {
    this.pollTimer = setInterval(() => {
      void this.dispatcher.dispatchPending().catch((error) => {
        this.logger.warn(
          `Pending dispatch poll failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, PENDING_POLL_MS);
    // Do not keep the process alive solely for the poller (tests / CLI).
    this.pollTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Device APIs
  // ---------------------------------------------------------------------------

  async registerDevice(
    userId: string,
    dto: RegisterNotificationDeviceDto,
  ): Promise<NotificationDeviceResponseDto> {
    const token = dto.token.trim();
    const now = new Date();

    const existing = await this.deviceRepository.findOne({ where: { token } });

    if (!existing) {
      const created = this.deviceRepository.create({
        id: randomUUID(),
        userId,
        token,
        platform: dto.platform,
        deviceId: dto.deviceId?.trim() || null,
        appVersion: dto.appVersion?.trim() || null,
        isActive: true,
        lastSeenAt: now,
      });
      const saved = await this.deviceRepository.save(created);
      return this.toDeviceResponse(saved);
    }

    existing.userId = userId;
    existing.platform = dto.platform;
    existing.isActive = true;
    existing.lastSeenAt = now;
    if (dto.deviceId !== undefined) {
      existing.deviceId = dto.deviceId.trim() || null;
    }
    if (dto.appVersion !== undefined) {
      existing.appVersion = dto.appVersion.trim() || null;
    }

    const saved = await this.deviceRepository.save(existing);
    return this.toDeviceResponse(saved);
  }

  async deactivateDevice(userId: string, token: string): Promise<{ ok: true }> {
    const normalized = decodeURIComponent(token).trim();
    const device = await this.deviceRepository.findOne({
      where: { token: normalized },
    });

    if (!device) {
      throw new NotFoundException('Device token not found');
    }
    if (device.userId !== userId) {
      throw new ForbiddenException('Cannot deactivate another user device');
    }

    device.isActive = false;
    device.lastSeenAt = new Date();
    await this.deviceRepository.save(device);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Core enqueue (never throws to business callers via safe* wrappers)
  // ---------------------------------------------------------------------------

  async enqueue(
    input: EnqueueNotificationInput,
    manager?: EntityManager,
  ): Promise<Notification | null> {
    if (isPlatformUserId(input.recipientUserId)) {
      return null;
    }

    const repo = manager
      ? manager.getRepository(Notification)
      : this.notificationRepository;

    const existing = await repo.findOne({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      if (existing.status === NotificationStatus.PENDING && !manager) {
        this.dispatcher.scheduleDispatch(existing.id);
      }
      return existing;
    }

    const row = repo.create({
      id: randomUUID(),
      recipientUserId: input.recipientUserId,
      type: input.type,
      title: input.title.slice(0, 200),
      body: input.body.slice(0, 500),
      data: input.data,
      status: NotificationStatus.PENDING,
      idempotencyKey: input.idempotencyKey,
      provider: NotificationProviderName.FCM,
      providerMessageId: null,
      attemptCount: 0,
      nextAttemptAt: null,
      sentAt: null,
      failedAt: null,
      failureReason: null,
      readAt: null,
    });

    try {
      const saved = await repo.save(row);
      if (!manager) {
        this.dispatcher.scheduleDispatch(saved.id);
      } else {
        // Outbox row shares the business TX; dispatch after commit via poller /
        // explicit flush. Schedule a delayed attempt for latency.
        setTimeout(() => {
          this.dispatcher.scheduleDispatch(saved.id);
        }, 250);
      }
      return saved;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const recovered = await repo.findOne({
          where: { idempotencyKey: input.idempotencyKey },
        });
        return recovered;
      }
      throw error;
    }
  }

  /**
   * Best-effort enqueue outside the caller's transaction.
   * Never throws to callers.
   */
  async safeEnqueue(input: EnqueueNotificationInput): Promise<void> {
    try {
      await this.enqueue(input);
    } catch (error) {
      this.logger.warn(
        `safeEnqueue failed key=${input.idempotencyKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Outbox insert using the caller's EntityManager (same TX as business event).
   * FCM is never called here. Never throws to callers.
   */
  async safeEnqueueInTransaction(
    manager: EntityManager,
    input: EnqueueNotificationInput,
  ): Promise<void> {
    try {
      await this.enqueue(input, manager);
    } catch (error) {
      this.logger.warn(
        `safeEnqueueInTransaction failed key=${input.idempotencyKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Business event helpers
  // ---------------------------------------------------------------------------

  async safeNotifyBookingReceived(params: {
    bookingId: string;
    rideId: string;
    driverId: string;
    passengerId: string;
    bookingMode?: 'REGULAR' | 'ASSURED';
  }): Promise<void> {
    const passengerName = await this.resolveDisplayName(params.passengerId);
    const isAssured = params.bookingMode === 'ASSURED';

    await this.safeEnqueue({
      recipientUserId: params.driverId,
      type: NotificationType.BOOKING_RECEIVED,
      title: isAssured ? 'New Assured booking' : 'New booking request',
      body: isAssured
        ? 'You have a new Assured ride booking.'
        : `${passengerName} requested a seat on your ride.`,
      data: {
        type: NotificationType.BOOKING_RECEIVED,
        bookingId: params.bookingId,
        rideId: params.rideId,
        ...(isAssured ? { bookingMode: 'ASSURED' } : {}),
      },
      idempotencyKey: bookingReceivedKey(params.bookingId),
    });
  }

  async safeNotifyBookingConfirmed(params: {
    bookingId: string;
    rideId: string;
    passengerId: string;
    bookingMode?: 'REGULAR' | 'ASSURED';
  }): Promise<void> {
    const isAssured = params.bookingMode === 'ASSURED';
    await this.safeEnqueue({
      recipientUserId: params.passengerId,
      type: NotificationType.BOOKING_CONFIRMED,
      title: isAssured ? 'Assured ride confirmed' : 'Ride confirmed',
      body: isAssured
        ? 'Your Assured ride has been confirmed.'
        : 'Your ride has been confirmed.',
      data: {
        type: NotificationType.BOOKING_CONFIRMED,
        bookingId: params.bookingId,
        rideId: params.rideId,
        ...(isAssured ? { bookingMode: 'ASSURED' } : {}),
      },
      idempotencyKey: bookingConfirmedKey(params.bookingId),
    });
  }

  async safeNotifyBookingCancelled(params: {
    bookingId: string;
    rideId: string;
    recipientUserId: string;
    bookingMode?: 'REGULAR' | 'ASSURED';
  }): Promise<void> {
    const isAssured = params.bookingMode === 'ASSURED';
    await this.safeEnqueue({
      recipientUserId: params.recipientUserId,
      type: NotificationType.BOOKING_CANCELLED,
      title: 'Ride cancelled',
      body: isAssured
        ? 'Your Assured ride booking has been cancelled.'
        : 'Your ride booking has been cancelled.',
      data: {
        type: NotificationType.BOOKING_CANCELLED,
        bookingId: params.bookingId,
        rideId: params.rideId,
        ...(isAssured ? { bookingMode: 'ASSURED' } : {}),
      },
      idempotencyKey: bookingCancelledKey(
        params.bookingId,
        params.recipientUserId,
      ),
    });
  }

  async safeNotifyCommuteRequested(params: {
    bookingId: string;
    rideId: string;
    driverId: string;
  }): Promise<void> {
    await this.safeEnqueue({
      recipientUserId: params.driverId,
      type: NotificationType.COMMUTE_BOOKING_REQUESTED,
      title: 'New commute request',
      body: 'Someone requested a seat on your office commute.',
      data: {
        type: NotificationType.COMMUTE_BOOKING_REQUESTED,
        bookingId: params.bookingId,
        rideId: params.rideId,
      },
      idempotencyKey: commuteRequestedKey(params.bookingId),
    });
  }

  async safeNotifyCommuteConfirmed(params: {
    bookingId: string;
    rideId: string;
    passengerId: string;
  }): Promise<void> {
    await this.safeEnqueue({
      recipientUserId: params.passengerId,
      type: NotificationType.COMMUTE_BOOKING_CONFIRMED,
      title: 'Commute confirmed',
      body: 'Your office commute ride has been confirmed.',
      data: {
        type: NotificationType.COMMUTE_BOOKING_CONFIRMED,
        bookingId: params.bookingId,
        rideId: params.rideId,
      },
      idempotencyKey: commuteConfirmedKey(params.bookingId),
    });
  }

  async safeNotifyCommuteCancelled(params: {
    bookingId: string;
    rideId: string;
    recipientUserId: string;
  }): Promise<void> {
    await this.safeEnqueue({
      recipientUserId: params.recipientUserId,
      type: NotificationType.COMMUTE_BOOKING_CANCELLED,
      title: 'Commute ride cancelled',
      body: 'Your office commute ride has been cancelled.',
      data: {
        type: NotificationType.COMMUTE_BOOKING_CANCELLED,
        bookingId: params.bookingId,
        rideId: params.rideId,
      },
      idempotencyKey: commuteCancelledKey(
        params.bookingId,
        params.recipientUserId,
      ),
    });
  }

  async safeNotifyAssuredPublished(params: {
    rideId: string;
    driverId: string;
  }): Promise<void> {
    await this.safeEnqueue({
      recipientUserId: params.driverId,
      type: NotificationType.ASSURED_RIDE_PUBLISHED,
      title: 'Your Assured ride is live',
      body: 'Your Assured ride has been published and is now available for booking.',
      data: {
        type: NotificationType.ASSURED_RIDE_PUBLISHED,
        rideId: params.rideId,
      },
      idempotencyKey: assuredPublishedKey(params.rideId),
    });
  }

  async safeNotifyWalletCredited(params: {
    userId: string;
    transactionId: string;
    amount: string | number | bigint;
    currency?: string;
  }): Promise<void> {
    if (isPlatformUserId(params.userId)) {
      return;
    }
    const amount = formatInrAmount(params.amount);
    await this.safeEnqueue({
      recipientUserId: params.userId,
      type: NotificationType.WALLET_CREDITED,
      title: 'Money added to your wallet',
      body: `₹${amount} has been added to your BhaiWay wallet.`,
      data: {
        type: NotificationType.WALLET_CREDITED,
        transactionId: params.transactionId,
        amount,
        currency: params.currency ?? 'INR',
      },
      idempotencyKey: walletCreditedKey(params.transactionId),
    });
  }

  /**
   * Wallet credit outbox inside the financial TX (record only; no FCM).
   */
  async safeNotifyWalletCreditedInTransaction(
    manager: EntityManager,
    params: {
      userId: string;
      transactionId: string;
      amount: string | number | bigint;
      currency?: string;
    },
  ): Promise<void> {
    if (isPlatformUserId(params.userId)) {
      return;
    }
    const amount = formatInrAmount(params.amount);
    await this.safeEnqueueInTransaction(manager, {
      recipientUserId: params.userId,
      type: NotificationType.WALLET_CREDITED,
      title: 'Money added to your wallet',
      body: `₹${amount} has been added to your BhaiWay wallet.`,
      data: {
        type: NotificationType.WALLET_CREDITED,
        transactionId: params.transactionId,
        amount,
        currency: params.currency ?? 'INR',
      },
      idempotencyKey: walletCreditedKey(params.transactionId),
    });
  }

  async safeNotifyChatMessage(params: {
    messageId: string;
    conversationId: string;
    bookingId: string;
    recipientUserId: string;
    senderUserId: string;
  }): Promise<void> {
    if (params.recipientUserId === params.senderUserId) {
      return;
    }
    const senderName = await this.resolveDisplayName(params.senderUserId);
    await this.safeEnqueue({
      recipientUserId: params.recipientUserId,
      type: NotificationType.CHAT_MESSAGE,
      title: 'BhaiWay',
      body: `New message from ${senderName}`,
      data: {
        type: NotificationType.CHAT_MESSAGE,
        conversationId: params.conversationId,
        messageId: params.messageId,
        bookingId: params.bookingId,
      },
      idempotencyKey: chatMessageKey(params.messageId),
    });
  }

  async flushDispatch(notificationId: string): Promise<void> {
    await this.dispatcher.dispatch(notificationId);
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<Notification | null> {
    return this.notificationRepository.findOne({ where: { idempotencyKey } });
  }

  private async resolveDisplayName(userId: string): Promise<string> {
    const profile = await this.profileRepository.findOne({
      where: { userId },
    });
    const display =
      profile?.displayName?.trim() ||
      [profile?.firstName, profile?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
    return display || 'A passenger';
  }

  private toDeviceResponse(
    device: NotificationDevice,
  ): NotificationDeviceResponseDto {
    return {
      id: device.id,
      platform: device.platform,
      deviceId: device.deviceId,
      appVersion: device.appVersion,
      isActive: device.isActive,
      lastSeenAt: device.lastSeenAt.toISOString(),
      createdAt: device.createdAt.toISOString(),
      tokenPreview: redactToken(device.token),
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    );
  }
}
