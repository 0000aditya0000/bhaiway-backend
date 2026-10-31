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
import { DataSource, EntityManager, In, QueryFailedError, Repository } from 'typeorm';

import { Ride } from '../rides/entities/ride.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { isPlatformUserId } from '../wallet/platform-wallet.constants';
import {
  buildCancellationBody,
  cancellationDataFields,
  type CancellationActor,
  type RideCancellationSnapshot,
} from './cancellation-notification.content';
import {
  MarkAllNotificationsReadDto,
  NotificationEmailDeliveryDto,
  NotificationItemDto,
  NotificationListQueryDto,
  NotificationPageDto,
  NotificationUnreadCountDto,
} from './dto/notification-inbox.dto';
import {
  NotificationDeviceResponseDto,
  RegisterNotificationDeviceDto,
} from './dto/register-device.dto';
import { NotificationDevice } from './entities/notification-device.entity';
import { NotificationEmailDelivery } from './entities/notification-email-delivery.entity';
import { Notification } from './entities/notification.entity';
import {
  NotificationProviderName,
  NotificationStatus,
  NotificationType,
} from './enums/notification.enums';
import { NotificationEmailService } from './notification-email.service';
import { NotificationsDispatcher } from './notifications.dispatcher';
import {
  adminRideCancelledKey,
  assuredPublishedKey,
  bookingCancelledKey,
  bookingConfirmedKey,
  bookingReceivedKey,
  chatMessageKey,
  commuteCancelledKey,
  commuteConfirmedKey,
  commuteRequestedKey,
  formatInrAmount,
  noShowClaimOpenedKey,
  noShowClaimResolvedKey,
  redactToken,
  walletCreditedKey,
  withdrawalCompletedKey,
  withdrawalInitiatedKey,
  withdrawalProcessingKey,
} from './notifications.helpers';
import type { EnqueueNotificationInput } from './notifications.types';

const PENDING_POLL_MS = 15_000;

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dispatcher: NotificationsDispatcher,
    private readonly notificationEmailService: NotificationEmailService,
    private readonly dataSource: DataSource,
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    @InjectRepository(NotificationDevice)
    private readonly deviceRepository: Repository<NotificationDevice>,
    @InjectRepository(NotificationEmailDelivery)
    private readonly emailDeliveryRepository: Repository<NotificationEmailDelivery>,
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
      this.scheduleEmail(existing.id, !!manager);
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
        this.scheduleEmail(saved.id, false);
      } else {
        // Outbox row shares the business TX; dispatch after commit via poller /
        // explicit flush. Schedule a delayed attempt for latency.
        setTimeout(() => {
          this.dispatcher.scheduleDispatch(saved.id);
        }, 250);
        this.scheduleEmail(saved.id, true);
      }
      return saved;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const recovered = await repo.findOne({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (recovered) {
          this.scheduleEmail(recovered.id, !!manager);
        }
        return recovered;
      }
      throw error;
    }
  }

  /**
   * Queue verified-email delivery independently of FCM.
   * Failures here never affect in-app persistence or push.
   */
  private scheduleEmail(notificationId: string, delayed: boolean): void {
    const run = () => {
      void this.notificationEmailService
        .ensureDeliveryQueued(notificationId)
        .catch((error) => {
          this.logger.warn(
            `Email queue schedule failed notification=${notificationId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    };
    if (delayed) {
      setTimeout(run, 300);
    } else {
      run();
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
    cancelledBy?: CancellationActor;
    cancellationReason?: string | null;
  }): Promise<void> {
    const isAssured = params.bookingMode === 'ASSURED';
    const snapshot = await this.loadRideSnapshot(params.rideId);
    const fallback = isAssured
      ? 'Your Assured ride booking has been cancelled.'
      : 'Your ride booking has been cancelled.';
    await this.safeEnqueue({
      recipientUserId: params.recipientUserId,
      type: NotificationType.BOOKING_CANCELLED,
      title: 'Ride cancelled',
      body: buildCancellationBody({
        fallback,
        actor: params.cancelledBy,
        snapshot,
        cancellationReason: params.cancellationReason,
        bookingId: params.bookingId,
        rideId: params.rideId,
      }),
      data: {
        type: NotificationType.BOOKING_CANCELLED,
        bookingId: params.bookingId,
        rideId: params.rideId,
        ...(isAssured ? { bookingMode: 'ASSURED' } : {}),
        ...cancellationDataFields({
          snapshot,
          cancelledBy: params.cancelledBy,
          cancellationReason: params.cancellationReason,
        }),
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
    cancelledBy?: CancellationActor;
    cancellationReason?: string | null;
  }): Promise<void> {
    const snapshot = await this.loadRideSnapshot(params.rideId);
    await this.safeEnqueue({
      recipientUserId: params.recipientUserId,
      type: NotificationType.COMMUTE_BOOKING_CANCELLED,
      title: 'Commute ride cancelled',
      body: buildCancellationBody({
        fallback: 'Your office commute ride has been cancelled.',
        actor: params.cancelledBy,
        snapshot,
        cancellationReason: params.cancellationReason,
        bookingId: params.bookingId,
        rideId: params.rideId,
      }),
      data: {
        type: NotificationType.COMMUTE_BOOKING_CANCELLED,
        bookingId: params.bookingId,
        rideId: params.rideId,
        ...cancellationDataFields({
          snapshot,
          cancelledBy: params.cancelledBy,
          cancellationReason: params.cancellationReason,
        }),
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

  /** Withdrawal request recorded (outbox row in the business TX). */
  async safeNotifyWithdrawalInitiatedInTransaction(
    manager: EntityManager,
    params: {
      userId: string;
      withdrawalId: string;
      referenceId: string;
      amount: string | number | bigint;
    },
  ): Promise<void> {
    const amount = formatInrAmount(params.amount);
    await this.safeEnqueueInTransaction(manager, {
      recipientUserId: params.userId,
      type: NotificationType.WITHDRAWAL_INITIATED,
      title: 'Withdrawal requested',
      body: `Your withdrawal request for ${amount} Coins has been received.`,
      data: {
        type: NotificationType.WITHDRAWAL_INITIATED,
        withdrawalId: params.withdrawalId,
        referenceId: params.referenceId,
        amount,
      },
      idempotencyKey: withdrawalInitiatedKey(params.withdrawalId),
    });
  }

  async safeNotifyWithdrawalProcessing(params: {
    userId: string;
    withdrawalId: string;
    referenceId: string;
    amount: string | number | bigint;
  }): Promise<void> {
    const amount = formatInrAmount(params.amount);
    await this.safeEnqueue({
      recipientUserId: params.userId,
      type: NotificationType.WITHDRAWAL_PROCESSING,
      title: 'Withdrawal is being processed',
      body: `Your withdrawal of ${amount} Coins is being processed.`,
      data: {
        type: NotificationType.WITHDRAWAL_PROCESSING,
        withdrawalId: params.withdrawalId,
        referenceId: params.referenceId,
        amount,
      },
      idempotencyKey: withdrawalProcessingKey(params.withdrawalId),
    });
  }

  async safeNotifyWithdrawalCompleted(params: {
    userId: string;
    withdrawalId: string;
    referenceId: string;
    amount: string | number | bigint;
  }): Promise<void> {
    const amount = formatInrAmount(params.amount);
    await this.safeEnqueue({
      recipientUserId: params.userId,
      type: NotificationType.WITHDRAWAL_COMPLETED,
      title: 'Withdrawal completed',
      body: `Your withdrawal of ${amount} Coins has been completed.`,
      data: {
        type: NotificationType.WITHDRAWAL_COMPLETED,
        withdrawalId: params.withdrawalId,
        referenceId: params.referenceId,
        amount,
      },
      idempotencyKey: withdrawalCompletedKey(params.withdrawalId),
    });
  }

  async safeNotifyAdminRideCancelled(params: {
    rideId: string;
    recipientUserId: string;
    role: 'driver' | 'passenger';
    body: string;
    inProgress: boolean;
    bookingId?: string;
    cancellationReason?: string | null;
  }): Promise<void> {
    const snapshot = await this.loadRideSnapshot(params.rideId);
    await this.safeEnqueue({
      recipientUserId: params.recipientUserId,
      type: NotificationType.ADMIN_RIDE_CANCELLED,
      title: 'Ride cancelled by BhaiWay Operations',
      body: buildCancellationBody({
        fallback: params.body,
        actor: 'admin',
        snapshot,
        cancellationReason: params.cancellationReason ?? 'ADMIN_CANCELLED',
        bookingId: params.bookingId,
        rideId: params.rideId,
      }),
      data: {
        type: NotificationType.ADMIN_RIDE_CANCELLED,
        rideId: params.rideId,
        role: params.role,
        inProgress: params.inProgress,
        bookingId: params.bookingId ?? null,
        ...cancellationDataFields({
          snapshot,
          cancelledBy: 'admin',
          cancellationReason: params.cancellationReason ?? 'ADMIN_CANCELLED',
        }),
      },
      idempotencyKey: adminRideCancelledKey(
        params.rideId,
        params.recipientUserId,
      ),
    });
  }

  async safeNotifyNoShowClaimOpened(params: {
    claimId: string;
    rideId: string;
    bookingId: string | null;
    recipientUserId: string;
    kind: 'DRIVER_NO_SHOW' | 'PASSENGER_NO_SHOW';
  }): Promise<void> {
    const isDriverClaim = params.kind === 'DRIVER_NO_SHOW';
    await this.safeEnqueue({
      recipientUserId: params.recipientUserId,
      type: NotificationType.NO_SHOW_CLAIM_OPENED,
      title: isDriverClaim
        ? 'Driver no-show reported'
        : 'Passenger no-show reported',
      body: isDriverClaim
        ? 'A passenger reported that you did not arrive. Approve or reject within 15 minutes.'
        : 'The driver reported that you did not arrive. Approve or reject within 15 minutes.',
      data: {
        type: NotificationType.NO_SHOW_CLAIM_OPENED,
        claimId: params.claimId,
        rideId: params.rideId,
        bookingId: params.bookingId,
        kind: params.kind,
      },
      idempotencyKey: noShowClaimOpenedKey(
        params.claimId,
        params.recipientUserId,
      ),
    });
  }

  async safeNotifyNoShowClaimResolved(params: {
    claimId: string;
    rideId: string;
    bookingId: string | null;
    recipientUserId: string;
    kind: 'DRIVER_NO_SHOW' | 'PASSENGER_NO_SHOW';
    resolution: 'approved' | 'rejected' | 'timeout';
  }): Promise<void> {
    await this.safeEnqueue(this.toNoShowResolvedInput(params));
  }

  /**
   * Inserts the resolved-claim inbox row (or returns the existing unique-key
   * row). Throws on unexpected failures so the No-Show effect outbox can retry.
   */
  async enqueueNoShowClaimResolved(
    params: {
      claimId: string;
      rideId: string;
      bookingId: string | null;
      recipientUserId: string;
      kind: 'DRIVER_NO_SHOW' | 'PASSENGER_NO_SHOW';
      resolution: 'approved' | 'rejected' | 'timeout';
    },
    manager?: EntityManager,
  ): Promise<void> {
    await this.enqueue(this.toNoShowResolvedInput(params), manager);
  }

  private toNoShowResolvedInput(params: {
    claimId: string;
    rideId: string;
    bookingId: string | null;
    recipientUserId: string;
    kind: 'DRIVER_NO_SHOW' | 'PASSENGER_NO_SHOW';
    resolution: 'approved' | 'rejected' | 'timeout';
  }): EnqueueNotificationInput {
    const type =
      params.resolution === 'approved'
        ? NotificationType.NO_SHOW_CLAIM_APPROVED
        : params.resolution === 'rejected'
          ? NotificationType.NO_SHOW_CLAIM_REJECTED
          : NotificationType.NO_SHOW_CLAIM_TIMEOUT;
    const title =
      params.resolution === 'approved'
        ? 'No-show claim approved'
        : params.resolution === 'rejected'
          ? 'No-show claim rejected'
          : 'No-show claim approved (no response)';
    const body =
      params.resolution === 'approved'
        ? 'The No-Show claim was approved and the ride/booking was settled.'
        : params.resolution === 'rejected'
          ? 'The No-Show claim was rejected. No penalties were applied. Open Help & Support if you need help.'
          : 'There was no response within 15 minutes, so the No-Show claim was approved automatically.';
    return {
      recipientUserId: params.recipientUserId,
      type,
      title,
      body,
      data: {
        type,
        claimId: params.claimId,
        rideId: params.rideId,
        bookingId: params.bookingId,
        kind: params.kind,
        resolution: params.resolution,
      },
      idempotencyKey: noShowClaimResolvedKey(
        params.claimId,
        params.recipientUserId,
        params.resolution,
      ),
    };
  }

  // ---------------------------------------------------------------------------
  // In-app notification center (inbox)
  // ---------------------------------------------------------------------------

  async listForUser(
    userId: string,
    query: NotificationListQueryDto,
  ): Promise<NotificationPageDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.notificationRepository
      .createQueryBuilder('n')
      .where('n.recipient_user_id = :userId', { userId })
      .orderBy('n.created_at', 'DESC')
      .addOrderBy('n.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.unreadOnly === true) {
      qb.andWhere('n.read_at IS NULL');
    }

    const [rows, total] = await qb.getManyAndCount();
    const emailByNotificationId = await this.loadEmailDeliveries(
      rows.map((row) => row.id),
    );
    return {
      items: rows.map((row) =>
        this.toInboxItem(row, emailByNotificationId.get(row.id) ?? null),
      ),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async unreadCountForUser(
    userId: string,
  ): Promise<NotificationUnreadCountDto> {
    const count = await this.notificationRepository
      .createQueryBuilder('n')
      .where('n.recipient_user_id = :userId', { userId })
      .andWhere('n.read_at IS NULL')
      .getCount();
    return { count };
  }

  async markAsReadForUser(
    userId: string,
    notificationId: string,
  ): Promise<NotificationItemDto> {
    const row = await this.notificationRepository.findOne({
      where: { id: notificationId, recipientUserId: userId },
    });
    if (!row) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification not found',
        error: 'Not Found',
      });
    }

    if (row.readAt == null) {
      row.readAt = new Date();
      await this.notificationRepository.save(row);
    }

    const email = await this.emailDeliveryRepository.findOne({
      where: { notificationId: row.id },
    });
    return this.toInboxItem(row, email);
  }

  async markAllAsReadForUser(
    userId: string,
  ): Promise<MarkAllNotificationsReadDto> {
    const now = new Date();
    const result = await this.notificationRepository
      .createQueryBuilder()
      .update(Notification)
      .set({ readAt: now })
      .where('recipient_user_id = :userId', { userId })
      .andWhere('read_at IS NULL')
      .execute();

    return { updatedCount: result.affected ?? 0 };
  }

  async flushDispatch(notificationId: string): Promise<void> {
    await this.dispatcher.dispatch(notificationId);
  }

  async flushEmail(notificationId: string): Promise<void> {
    await this.notificationEmailService.ensureDeliveryQueued(notificationId);
    await this.notificationEmailService.deliver(notificationId);
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<Notification | null> {
    return this.notificationRepository.findOne({ where: { idempotencyKey } });
  }

  async findEmailDelivery(
    notificationId: string,
  ): Promise<NotificationEmailDelivery | null> {
    return this.emailDeliveryRepository.findOne({
      where: { notificationId },
    });
  }

  private toInboxItem(
    row: Notification,
    email: NotificationEmailDelivery | null = null,
  ): NotificationItemDto {
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      type: row.type,
      data: row.data ?? { type: row.type },
      isRead: row.readAt != null,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt ? row.readAt.toISOString() : null,
      emailDelivery: email ? this.toEmailDeliveryDto(email) : null,
    };
  }

  private toEmailDeliveryDto(
    row: NotificationEmailDelivery,
  ): NotificationEmailDeliveryDto {
    return {
      status: row.status,
      skipReason: row.skipReason,
      failureReason: row.failureReason,
      attemptCount: row.attemptCount,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    };
  }

  private async loadEmailDeliveries(
    notificationIds: string[],
  ): Promise<Map<string, NotificationEmailDelivery>> {
    const map = new Map<string, NotificationEmailDelivery>();
    if (notificationIds.length === 0) {
      return map;
    }
    const rows = await this.emailDeliveryRepository.find({
      where: { notificationId: In(notificationIds) },
    });
    for (const row of rows) {
      map.set(row.notificationId, row);
    }
    return map;
  }

  private async loadRideSnapshot(
    rideId: string,
  ): Promise<RideCancellationSnapshot | null> {
    try {
      const ride = await this.dataSource.getRepository(Ride).findOne({
        where: { id: rideId },
        select: {
          id: true,
          source: true,
          destination: true,
          departureDate: true,
          departureTime: true,
        },
      });
      if (!ride) {
        return null;
      }
      return {
        source: ride.source,
        destination: ride.destination,
        departureDate: ride.departureDate,
        departureTime: ride.departureTime,
      };
    } catch (error) {
      this.logger.warn(
        `Ride snapshot load failed ride=${rideId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async resolveDisplayName(userId: string): Promise<string> {
    const profile = await this.profileRepository.findOne({
      where: { userId },
    });
    const display =
      profile?.displayName?.trim() ||
      [profile?.firstName, profile?.lastName].filter(Boolean).join(' ').trim();
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
