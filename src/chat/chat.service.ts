import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import {
  DataSource,
  In,
  QueryFailedError,
  Repository,
} from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingMode,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus } from '../rides/enums/ride.enums';
import { UserProfile } from '../users/entities/user-profile.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ChatConversationDto,
  ChatConversationListDto,
  ChatMessageAckDto,
  ChatMessageDto,
  ChatMessagesPageDto,
  ChatReadResultDto,
} from './dto/chat.dto';
import { ChatConversation } from './entities/chat-conversation.entity';
import { ChatMessage } from './entities/chat-message.entity';
import {
  ChatConversationStatus,
  ChatMessageType,
} from './enums/chat.enums';
import {
  ChatClosedError,
  ChatForbiddenError,
  ChatMessageValidationError,
} from './errors/chat.errors';

const MAX_MESSAGE_LENGTH = 1000;
const DEFAULT_MESSAGE_LIMIT = 50;

export type ChatRealtimePayload =
  | {
      type: 'message';
      conversationId: string;
      message: ChatMessageDto;
    }
  | {
      type: 'read';
      conversationId: string;
      readerId: string;
      readAt: string;
      markedCount: number;
    }
  | {
      type: 'typing' | 'stop_typing';
      conversationId: string;
      userId: string;
    }
  | {
      type: 'conversation_closed';
      conversationId: string;
      closedAt: string;
    };

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private realtimePublisher:
    | ((payload: ChatRealtimePayload) => void)
    | null = null;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(ChatConversation)
    private readonly conversationRepository: Repository<ChatConversation>,
    @InjectRepository(ChatMessage)
    private readonly messageRepository: Repository<ChatMessage>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(UserProfile)
    private readonly profileRepository: Repository<UserProfile>,
    private readonly notificationsService: NotificationsService,
  ) {}

  setRealtimePublisher(
    publisher: ((payload: ChatRealtimePayload) => void) | null,
  ): void {
    this.realtimePublisher = publisher;
  }

  /**
   * Best-effort open after booking create. Never throws to callers.
   */
  async safeEnsureOpenForBooking(bookingId: string): Promise<void> {
    try {
      await this.ensureOpenForBooking(bookingId);
    } catch (error) {
      this.logger.warn(
        `[Chat] ensureOpen failed booking=${bookingId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Best-effort close for one booking. Never throws to callers.
   */
  async safeCloseForBooking(bookingId: string): Promise<void> {
    try {
      await this.closeForBooking(bookingId);
    } catch (error) {
      this.logger.warn(
        `[Chat] closeForBooking failed booking=${bookingId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Best-effort close all conversations on a ride. Never throws to callers.
   */
  async safeCloseForRide(rideId: string): Promise<void> {
    try {
      await this.closeForRide(rideId);
    } catch (error) {
      this.logger.warn(
        `[Chat] closeForRide failed ride=${rideId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // Residual OPEN rows on terminal rides are closed without affecting finance.
    await this.reconcileConversationsForRide(rideId);
  }

  async ensureOpenForBooking(bookingId: string): Promise<ChatConversation> {
    const existing = await this.conversationRepository.findOne({
      where: { bookingId },
    });
    if (existing) {
      return existing;
    }

    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (!this.isChatEligibleBooking(booking)) {
      throw new ChatMessageValidationError(
        'Booking is not eligible for chat yet',
      );
    }

    const ride = await this.rideRepository.findOne({
      where: { id: booking.rideId },
    });
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    if (booking.passengerId === ride.driverId) {
      throw new ChatMessageValidationError(
        'Driver cannot chat with themselves',
      );
    }

    try {
      const conversation = this.conversationRepository.create({
        id: randomUUID(),
        rideId: ride.id,
        bookingId: booking.id,
        driverId: ride.driverId,
        passengerId: booking.passengerId,
        status: ChatConversationStatus.OPEN,
        lastMessageAt: null,
        closedAt: null,
      });
      return await this.conversationRepository.save(conversation);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const recovered = await this.conversationRepository.findOne({
          where: { bookingId },
        });
        if (recovered) {
          return recovered;
        }
      }
      throw error;
    }
  }

  async closeForBooking(bookingId: string): Promise<void> {
    const conversation = await this.conversationRepository.findOne({
      where: { bookingId },
    });
    if (!conversation || conversation.status === ChatConversationStatus.CLOSED) {
      return;
    }

    const closedAt = new Date();
    conversation.status = ChatConversationStatus.CLOSED;
    conversation.closedAt = closedAt;
    await this.conversationRepository.save(conversation);

    this.publishRealtime({
      type: 'conversation_closed',
      conversationId: conversation.id,
      closedAt: closedAt.toISOString(),
    });
  }

  async closeForRide(rideId: string): Promise<void> {
    const openConversations = await this.conversationRepository.find({
      where: {
        rideId,
        status: ChatConversationStatus.OPEN,
      },
    });

    if (openConversations.length === 0) {
      return;
    }

    const closedAt = new Date();
    for (const conversation of openConversations) {
      conversation.status = ChatConversationStatus.CLOSED;
      conversation.closedAt = closedAt;
    }
    await this.conversationRepository.save(openConversations);

    for (const conversation of openConversations) {
      this.publishRealtime({
        type: 'conversation_closed',
        conversationId: conversation.id,
        closedAt: closedAt.toISOString(),
      });
    }
  }

  async listConversations(userId: string): Promise<ChatConversationListDto> {
    const conversations = await this.conversationRepository
      .createQueryBuilder('c')
      .where('c.driver_id = :userId OR c.passenger_id = :userId', { userId })
      .orderBy('COALESCE(c.last_message_at, c.created_at)', 'DESC')
      .getMany();

    if (conversations.length === 0) {
      return { items: [] };
    }

    const otherIds = [
      ...new Set(
        conversations.map((c) =>
          c.driverId === userId ? c.passengerId : c.driverId,
        ),
      ),
    ];
    const conversationIds = conversations.map((c) => c.id);

    const [profiles, lastMessages, unreadRows] = await Promise.all([
      this.profileRepository.find({
        where: { userId: In(otherIds) },
      }),
      this.messageRepository
        .createQueryBuilder('m')
        .distinctOn(['m.conversation_id'])
        .where('m.conversation_id IN (:...ids)', { ids: conversationIds })
        .orderBy('m.conversation_id', 'ASC')
        .addOrderBy('m.created_at', 'DESC')
        .getMany(),
      this.messageRepository
        .createQueryBuilder('m')
        .select('m.conversation_id', 'conversationId')
        .addSelect('COUNT(*)', 'count')
        .where('m.conversation_id IN (:...ids)', { ids: conversationIds })
        .andWhere('m.sender_id <> :userId', { userId })
        .andWhere('m.read_at IS NULL')
        .groupBy('m.conversation_id')
        .getRawMany<{ conversationId: string; count: string }>(),
    ]);

    const profileByUserId = new Map(
      profiles.map((p) => [p.userId, p] as const),
    );
    const lastByConversation = new Map(
      lastMessages.map((m) => [m.conversationId, m] as const),
    );
    const unreadByConversation = new Map(
      unreadRows.map((r) => [r.conversationId, Number(r.count)] as const),
    );

    return {
      items: conversations.map((c) =>
        this.toConversationDto(
          c,
          userId,
          profileByUserId.get(
            c.driverId === userId ? c.passengerId : c.driverId,
          ),
          lastByConversation.get(c.id) ?? null,
          unreadByConversation.get(c.id) ?? 0,
        ),
      ),
    };
  }

  async getConversation(
    userId: string,
    conversationId: string,
  ): Promise<ChatConversationDto> {
    const conversation = await this.requireParticipant(
      userId,
      conversationId,
    );
    const otherId =
      conversation.driverId === userId
        ? conversation.passengerId
        : conversation.driverId;
    const [profile, lastMessage, unreadCount] = await Promise.all([
      this.profileRepository.findOne({ where: { userId: otherId } }),
      this.messageRepository.findOne({
        where: { conversationId },
        order: { createdAt: 'DESC' },
      }),
      this.messageRepository
        .createQueryBuilder('m')
        .where('m.conversation_id = :conversationId', { conversationId })
        .andWhere('m.sender_id <> :userId', { userId })
        .andWhere('m.read_at IS NULL')
        .getCount(),
    ]);

    return this.toConversationDto(
      conversation,
      userId,
      profile,
      lastMessage,
      unreadCount,
    );
  }

  async listMessages(
    userId: string,
    conversationId: string,
    options: { limit?: number; before?: string } = {},
  ): Promise<ChatMessagesPageDto> {
    await this.requireParticipant(userId, conversationId);

    const limit = Math.min(
      Math.max(options.limit ?? DEFAULT_MESSAGE_LIMIT, 1),
      100,
    );

    const qb = this.messageRepository
      .createQueryBuilder('m')
      .where('m.conversation_id = :conversationId', { conversationId })
      .orderBy('m.created_at', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .take(limit + 1);

    if (options.before) {
      const cursor = await this.messageRepository.findOne({
        where: { id: options.before, conversationId },
      });
      if (!cursor) {
        throw new NotFoundException('Cursor message not found');
      }
      qb.andWhere(
        '(m.created_at < :cursorAt OR (m.created_at = :cursorAt AND m.id < :cursorId))',
        {
          cursorAt: cursor.createdAt,
          cursorId: cursor.id,
        },
      );
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((m) =>
      this.toMessageDto(m),
    );

    return {
      items,
      nextBefore: hasMore && items.length > 0 ? items[items.length - 1].id : null,
      hasMore,
    };
  }

  async sendMessage(
    userId: string,
    conversationId: string,
    input: {
      clientMessageId: string;
      message: string;
      messageType?: ChatMessageType;
    },
  ): Promise<ChatMessageAckDto> {
    if (
      input.messageType !== undefined &&
      input.messageType !== ChatMessageType.TEXT
    ) {
      throw new ChatMessageValidationError(
        'Only TEXT messages are supported in V1',
      );
    }

    const conversation = await this.requireParticipant(
      userId,
      conversationId,
    );

    if (conversation.status !== ChatConversationStatus.OPEN) {
      throw new ChatClosedError();
    }

    const trimmed = this.normalizeMessage(input.message);
    const clientMessageId = input.clientMessageId?.trim();
    if (!clientMessageId) {
      throw new ChatMessageValidationError('clientMessageId is required');
    }

    const existing = await this.messageRepository.findOne({
      where: { senderId: userId, clientMessageId },
    });
    if (existing) {
      if (existing.conversationId !== conversationId) {
        throw new ChatMessageValidationError(
          'clientMessageId already used in another conversation',
        );
      }
      return {
        clientMessageId: existing.clientMessageId,
        messageId: existing.id,
        status: 'DUPLICATE',
        message: this.toMessageDto(existing),
      };
    }

    let saved: ChatMessage;
    try {
      saved = await this.dataSource.transaction(async (manager) => {
        const locked = await manager
          .getRepository(ChatConversation)
          .createQueryBuilder('c')
          .setLock('pessimistic_write')
          .where('c.id = :conversationId', { conversationId })
          .getOne();

        if (!locked) {
          throw new NotFoundException('Conversation not found');
        }
        if (locked.status !== ChatConversationStatus.OPEN) {
          throw new ChatClosedError();
        }
        if (locked.driverId !== userId && locked.passengerId !== userId) {
          throw new ChatForbiddenError();
        }

        const message = manager.getRepository(ChatMessage).create({
          id: randomUUID(),
          conversationId,
          senderId: userId,
          clientMessageId,
          messageType: ChatMessageType.TEXT,
          message: trimmed,
          readAt: null,
        });

        const inserted = await manager.getRepository(ChatMessage).save(message);
        locked.lastMessageAt = inserted.createdAt;
        await manager.getRepository(ChatConversation).save(locked);
        return inserted;
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const recovered = await this.messageRepository.findOne({
          where: { senderId: userId, clientMessageId },
        });
        if (recovered && recovered.conversationId === conversationId) {
          return {
            clientMessageId: recovered.clientMessageId,
            messageId: recovered.id,
            status: 'DUPLICATE',
            message: this.toMessageDto(recovered),
          };
        }
      }
      throw error;
    }

    const dto = this.toMessageDto(saved);
    this.publishRealtime({
      type: 'message',
      conversationId,
      message: dto,
    });

    const recipientUserId =
      conversation.driverId === userId
        ? conversation.passengerId
        : conversation.driverId;
    await this.notificationsService.safeNotifyChatMessage({
      messageId: saved.id,
      conversationId,
      bookingId: conversation.bookingId,
      recipientUserId,
      senderUserId: userId,
    });

    return {
      clientMessageId: saved.clientMessageId,
      messageId: saved.id,
      status: 'SENT',
      message: dto,
    };
  }

  async markRead(
    userId: string,
    conversationId: string,
    upToMessageId?: string,
  ): Promise<ChatReadResultDto> {
    await this.requireParticipant(userId, conversationId);

    const readAt = new Date();
    const qb = this.messageRepository
      .createQueryBuilder()
      .update(ChatMessage)
      .set({ readAt })
      .where('conversation_id = :conversationId', { conversationId })
      .andWhere('sender_id <> :userId', { userId })
      .andWhere('read_at IS NULL');

    if (upToMessageId) {
      const cursor = await this.messageRepository.findOne({
        where: { id: upToMessageId, conversationId },
      });
      if (!cursor) {
        throw new NotFoundException('Cursor message not found');
      }
      qb.andWhere('created_at <= :cursorAt', { cursorAt: cursor.createdAt });
    }

    const result = await qb.execute();
    const markedCount = result.affected ?? 0;

    if (markedCount > 0) {
      this.publishRealtime({
        type: 'read',
        conversationId,
        readerId: userId,
        readAt: readAt.toISOString(),
        markedCount,
      });
    }

    return {
      markedCount,
      readAt: readAt.toISOString(),
    };
  }

  async assertCanType(userId: string, conversationId: string): Promise<void> {
    const conversation = await this.requireParticipant(
      userId,
      conversationId,
    );
    if (conversation.status !== ChatConversationStatus.OPEN) {
      throw new ChatClosedError();
    }
  }

  publishTyping(
    userId: string,
    conversationId: string,
    typing: boolean,
  ): void {
    this.publishRealtime({
      type: typing ? 'typing' : 'stop_typing',
      conversationId,
      userId,
    });
  }

  private async requireParticipant(
    userId: string,
    conversationId: string,
  ): Promise<ChatConversation> {
    const conversation = await this.conversationRepository.findOne({
      where: { id: conversationId },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    if (
      conversation.driverId !== userId &&
      conversation.passengerId !== userId
    ) {
      throw new ChatForbiddenError();
    }

    const booking = await this.bookingRepository.findOne({
      where: { id: conversation.bookingId },
    });
    if (
      !booking ||
      booking.rideId !== conversation.rideId ||
      booking.passengerId !== conversation.passengerId
    ) {
      throw new ChatForbiddenError('Conversation booking relationship invalid');
    }

    return this.reconcileStaleConversation(conversation, booking);
  }

  /**
   * Lazy reconciliation: if the ride/booking is already terminal but chat
   * remained OPEN (best-effort close failed after settlement), close now.
   * Never throws — leave conversation as-is on reconcile failure.
   */
  private async reconcileStaleConversation(
    conversation: ChatConversation,
    booking: Booking,
  ): Promise<ChatConversation> {
    if (conversation.status === ChatConversationStatus.CLOSED) {
      return conversation;
    }

    try {
      const ride = await this.rideRepository.findOne({
        where: { id: conversation.rideId },
        select: { id: true, status: true, driverId: true },
      });

      const rideTerminal =
        !ride ||
        ride.status === RideStatus.COMPLETED ||
        ride.status === RideStatus.CANCELLED;
      const bookingTerminal =
        booking.status === BookingStatus.CANCELLED ||
        booking.status === BookingStatus.COMPLETED;
      const driverMismatch = !!ride && ride.driverId !== conversation.driverId;

      if (!rideTerminal && !bookingTerminal && !driverMismatch) {
        return conversation;
      }

      await this.closeForBooking(conversation.bookingId);
      const refreshed = await this.conversationRepository.findOne({
        where: { id: conversation.id },
      });
      return refreshed ?? conversation;
    } catch (error) {
      this.logger.warn(
        `[Chat] reconcile failed conversation=${conversation.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return conversation;
    }
  }

  /**
   * Idempotent repair for a ride after completion/cancel when post-TX close
   * may have failed. Safe to call repeatedly; never throws to callers.
   */
  async reconcileConversationsForRide(rideId: string): Promise<number> {
    try {
      const open = await this.conversationRepository.find({
        where: {
          rideId,
          status: ChatConversationStatus.OPEN,
        },
      });
      if (open.length === 0) {
        return 0;
      }

      const ride = await this.rideRepository.findOne({
        where: { id: rideId },
        select: { id: true, status: true },
      });
      if (
        !ride ||
        (ride.status !== RideStatus.COMPLETED &&
          ride.status !== RideStatus.CANCELLED)
      ) {
        // Still close per-booking when booking itself is terminal.
        let closed = 0;
        for (const conversation of open) {
          const booking = await this.bookingRepository.findOne({
            where: { id: conversation.bookingId },
          });
          if (
            booking &&
            (booking.status === BookingStatus.CANCELLED ||
              booking.status === BookingStatus.COMPLETED)
          ) {
            await this.closeForBooking(conversation.bookingId);
            closed += 1;
          }
        }
        return closed;
      }

      await this.closeForRide(rideId);
      return open.length;
    } catch (error) {
      this.logger.warn(
        `[Chat] reconcileConversationsForRide failed ride=${rideId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  private isChatEligibleBooking(booking: Booking): boolean {
    if (booking.bookingMode === BookingMode.COMMUTE) {
      return (
        booking.status === BookingStatus.PENDING ||
        booking.status === BookingStatus.CONFIRMED
      );
    }
    return booking.status === BookingStatus.CONFIRMED;
  }

  private normalizeMessage(raw: string): string {
    if (typeof raw !== 'string') {
      throw new ChatMessageValidationError('message is required');
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new ChatMessageValidationError('message cannot be blank');
    }
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      throw new ChatMessageValidationError(
        `message must be at most ${MAX_MESSAGE_LENGTH} characters`,
      );
    }
    return trimmed;
  }

  private toMessageDto(message: ChatMessage): ChatMessageDto {
    return {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      clientMessageId: message.clientMessageId,
      messageType: message.messageType,
      message: message.message,
      createdAt: message.createdAt.toISOString(),
      readAt: message.readAt ? message.readAt.toISOString() : null,
    };
  }

  private toConversationDto(
    conversation: ChatConversation,
    viewerId: string,
    otherProfile: UserProfile | null | undefined,
    lastMessage: ChatMessage | null,
    unreadCount: number,
  ): ChatConversationDto {
    const otherId =
      conversation.driverId === viewerId
        ? conversation.passengerId
        : conversation.driverId;

    return {
      id: conversation.id,
      rideId: conversation.rideId,
      bookingId: conversation.bookingId,
      status: conversation.status,
      otherParticipant: {
        id: otherId,
        displayName:
          otherProfile?.displayName ?? otherProfile?.firstName ?? null,
        profilePhoto: otherProfile?.profilePhoto ?? null,
      },
      lastMessage: lastMessage
        ? {
            id: lastMessage.id,
            senderId: lastMessage.senderId,
            message: lastMessage.message,
            createdAt: lastMessage.createdAt.toISOString(),
          }
        : null,
      lastMessageAt: conversation.lastMessageAt
        ? conversation.lastMessageAt.toISOString()
        : null,
      unreadCount,
      closedAt: conversation.closedAt
        ? conversation.closedAt.toISOString()
        : null,
      createdAt: conversation.createdAt.toISOString(),
    };
  }

  private publishRealtime(payload: ChatRealtimePayload): void {
    try {
      this.realtimePublisher?.(payload);
    } catch (error) {
      this.logger.warn(
        `[Chat] realtime publish failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      typeof (error as QueryFailedError & { driverError?: { code?: string } })
        .driverError?.code === 'string' &&
      (error as QueryFailedError & { driverError: { code: string } })
        .driverError.code === '23505'
    );
  }
}
