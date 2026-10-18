import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'crypto';
import { DataSource, In, Repository } from 'typeorm';

import { AdminAlertService } from '../admin/admin-alert.service';
import {
  AdminAlertCategory,
  AdminAlertSeverity,
} from '../admin/entities/admin-alert.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { BookingStatus } from '../bookings/enums/booking.enums';
import { NotificationType } from '../notifications/enums/notification.enums';
import { NotificationsService } from '../notifications/notifications.service';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus } from '../rides/enums/ride.enums';
import { UserProfile } from '../users/entities/user-profile.entity';
import { loadUserDisplayNamesByUserIds } from '../users/user-display-name.util';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import { AddSupportCommentDto } from './dto/add-support-comment.dto';
import { AdminSupportTicketListQueryDto } from './dto/admin-support-ticket-query.dto';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';
import { EligibleRidesQueryDto } from './dto/eligible-rides-query.dto';
import {
  AdminSupportTicketListItemDto,
  EligibleSupportRideDto,
  EligibleSupportRidePageDto,
  SupportAttachmentDto,
  SupportCommentDto,
  SupportRelatedRideSummaryDto,
  SupportStatusHistoryDto,
  SupportTicketDetailDto,
  SupportTicketListItemDto,
  SupportTicketPageDto,
} from './dto/support-ticket-response.dto';
import { SupportTicketListQueryDto } from './dto/support-ticket-query.dto';
import { UpdateSupportTicketStatusDto } from './dto/update-support-ticket-status.dto';
import { SupportTicketAttachment } from './entities/support-ticket-attachment.entity';
import { SupportTicketComment } from './entities/support-ticket-comment.entity';
import { SupportTicketStatusHistory } from './entities/support-ticket-status-history.entity';
import { SupportTicket } from './entities/support-ticket.entity';
import {
  SUPPORT_ATTACHMENT_MAX,
  SUPPORT_CATEGORY_SUBCATEGORIES,
  SUPPORT_STATUS_TRANSITIONS,
  SUPPORT_SUBJECT_MAX,
  SupportCommentAuthorType,
  SupportEligibleRidePeriod,
  SupportRideRelationRole,
  SupportTicketCategory,
  SupportTicketStatus,
} from './enums/support.enums';
import {
  SupportAttachmentInvalidError,
  SupportAttachmentLimitError,
  SupportInvalidCategoryError,
  SupportRideForbiddenError,
  SupportRideIneligibleError,
  SupportRideRequiredError,
  SupportStatusTransitionError,
  SupportTicketNotFoundError,
  SupportTicketResolvedError,
  SupportTransactionInvalidError,
} from './errors/support.errors';
import { validateSupportAttachmentUrl } from './support-attachment.util';

const ACTIVE_RIDE_STATUSES: RideStatus[] = [
  RideStatus.PUBLISHED,
  RideStatus.ASSURANCE_PENDING,
  RideStatus.ASSURANCE_ACTIVE,
  RideStatus.IN_PROGRESS,
];

const PAST_RIDE_STATUSES: RideStatus[] = [
  RideStatus.COMPLETED,
  RideStatus.CANCELLED,
];

const ACTIVE_BOOKING_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
];

const PAST_BOOKING_STATUSES: BookingStatus[] = [
  BookingStatus.COMPLETED,
  BookingStatus.CANCELLED,
];

@Injectable()
export class SupportService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly notificationsService: NotificationsService,
    private readonly adminAlertService: AdminAlertService,
    @InjectRepository(SupportTicket)
    private readonly ticketRepository: Repository<SupportTicket>,
    @InjectRepository(SupportTicketComment)
    private readonly commentRepository: Repository<SupportTicketComment>,
    @InjectRepository(SupportTicketAttachment)
    private readonly attachmentRepository: Repository<SupportTicketAttachment>,
    @InjectRepository(SupportTicketStatusHistory)
    private readonly historyRepository: Repository<SupportTicketStatusHistory>,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(WalletTransaction)
    private readonly walletTxRepository: Repository<WalletTransaction>,
    @InjectRepository(UserProfile)
    private readonly profileRepository: Repository<UserProfile>,
  ) {}

  // ---------------------------------------------------------------------------
  // Eligible rides
  // ---------------------------------------------------------------------------

  async listEligibleRides(
    userId: string,
    query: EligibleRidesQueryDto,
  ): Promise<EligibleSupportRidePageDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const period = query.period;

    const driverStatuses =
      period === SupportEligibleRidePeriod.ACTIVE
        ? ACTIVE_RIDE_STATUSES
        : PAST_RIDE_STATUSES;
    const bookingStatuses =
      period === SupportEligibleRidePeriod.ACTIVE
        ? ACTIVE_BOOKING_STATUSES
        : PAST_BOOKING_STATUSES;

    const [driverRides, passengerBookings] = await Promise.all([
      this.rideRepository.find({
        where: { driverId: userId, status: In(driverStatuses) },
        order: { departureDate: 'DESC', departureTime: 'DESC' },
      }),
      this.bookingRepository.find({
        where: { passengerId: userId, status: In(bookingStatuses) },
        order: { createdAt: 'DESC' },
      }),
    ]);

    const passengerRideIds = [
      ...new Set(passengerBookings.map((b) => b.rideId)),
    ];
    const passengerRides =
      passengerRideIds.length === 0
        ? []
        : await this.rideRepository.find({
            where: { id: In(passengerRideIds) },
          });
    const rideById = new Map(passengerRides.map((r) => [r.id, r] as const));

    const items: EligibleSupportRideDto[] = [];
    const seenRideIds = new Set<string>();

    for (const ride of driverRides) {
      seenRideIds.add(ride.id);
      items.push(
        this.toEligibleRideDto(ride, null, SupportRideRelationRole.DRIVER),
      );
    }

    for (const booking of passengerBookings) {
      const ride = rideById.get(booking.rideId);
      if (!ride) {
        continue;
      }
      // Prefer passenger view when user is also driver of same ride.
      if (seenRideIds.has(ride.id) && ride.driverId === userId) {
        const existingIdx = items.findIndex((i) => i.rideId === ride.id);
        if (existingIdx >= 0) {
          items[existingIdx] = this.toEligibleRideDto(
            ride,
            booking,
            SupportRideRelationRole.PASSENGER,
          );
        }
        continue;
      }
      if (seenRideIds.has(ride.id)) {
        continue;
      }
      seenRideIds.add(ride.id);
      items.push(
        this.toEligibleRideDto(
          ride,
          booking,
          SupportRideRelationRole.PASSENGER,
        ),
      );
    }

    items.sort((a, b) => {
      const dateCmp = b.departureDate.localeCompare(a.departureDate);
      if (dateCmp !== 0) return dateCmp;
      return b.departureTime.localeCompare(a.departureTime);
    });

    const total = items.length;
    const start = (page - 1) * limit;
    const pageItems = items.slice(start, start + limit);

    return {
      items: pageItems,
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  // ---------------------------------------------------------------------------
  // Create ticket
  // ---------------------------------------------------------------------------

  async createTicket(
    userId: string,
    dto: CreateSupportTicketDto,
  ): Promise<SupportTicketDetailDto> {
    this.assertCategorySubcategory(dto.category, dto.subcategory);

    const attachmentUrls = dto.attachmentUrls ?? [];
    if (attachmentUrls.length > SUPPORT_ATTACHMENT_MAX) {
      throw new SupportAttachmentLimitError();
    }
    const validatedAttachments = attachmentUrls.map((url) => {
      const result = validateSupportAttachmentUrl(url);
      if ('error' in result) {
        throw new SupportAttachmentInvalidError(result.error);
      }
      return result;
    });

    if (dto.idempotencyKey) {
      const existing = await this.ticketRepository.findOne({
        where: { userId, idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        return this.getTicketForUser(userId, existing.id);
      }
    }

    let relatedRideId: string | null = null;
    let relatedBookingId: string | null = null;
    let relatedWalletTransactionId: string | null = null;
    let relationRole: SupportRideRelationRole | null = null;

    if (dto.category === SupportTicketCategory.BOOKINGS_AND_RIDES) {
      if (!dto.relatedRideId) {
        throw new SupportRideRequiredError();
      }
      const eligibility = await this.resolveRideEligibility(
        userId,
        dto.relatedRideId,
      );
      relatedRideId = eligibility.ride.id;
      relatedBookingId = eligibility.booking?.id ?? null;
      relationRole = eligibility.role;
    } else if (dto.relatedRideId) {
      throw new SupportInvalidCategoryError(
        'relatedRideId is only allowed for BOOKINGS_AND_RIDES',
      );
    }

    if (dto.relatedWalletTransactionId) {
      if (dto.category !== SupportTicketCategory.PAYMENTS_AND_WALLETS) {
        throw new SupportInvalidCategoryError(
          'relatedWalletTransactionId is only allowed for PAYMENTS_AND_WALLETS',
        );
      }
      const tx = await this.walletTxRepository.findOne({
        where: { id: dto.relatedWalletTransactionId, userId },
      });
      if (!tx) {
        throw new SupportTransactionInvalidError();
      }
      relatedWalletTransactionId = tx.id;
    }

    const subject = this.buildSubject(dto.category, dto.subcategory);
    const reference = await this.generateUniqueReference();

    const ticketId = await this.dataSource.transaction(async (manager) => {
      const ticketRepo = manager.getRepository(SupportTicket);
      const historyRepo = manager.getRepository(SupportTicketStatusHistory);
      const attachmentRepo = manager.getRepository(SupportTicketAttachment);

      if (dto.idempotencyKey) {
        const raced = await ticketRepo.findOne({
          where: { userId, idempotencyKey: dto.idempotencyKey },
        });
        if (raced) {
          return raced.id;
        }
      }

      const ticket = ticketRepo.create({
        id: randomUUID(),
        reference,
        userId,
        category: dto.category,
        subcategory: dto.subcategory,
        subject,
        description: dto.description,
        status: SupportTicketStatus.CREATED,
        relatedRideId,
        relatedBookingId,
        relatedWalletTransactionId,
        assigneeAdminUserId: null,
        resolvedAt: null,
        idempotencyKey: dto.idempotencyKey?.trim() || null,
      });

      try {
        await ticketRepo.save(ticket);
      } catch (error) {
        if (dto.idempotencyKey && this.isUniqueViolation(error)) {
          const recovered = await ticketRepo.findOne({
            where: { userId, idempotencyKey: dto.idempotencyKey },
          });
          if (recovered) {
            return recovered.id;
          }
        }
        throw error;
      }

      await historyRepo.save(
        historyRepo.create({
          id: randomUUID(),
          ticketId: ticket.id,
          fromStatus: null,
          toStatus: SupportTicketStatus.CREATED,
          changedByUserId: userId,
          changedByAdmin: false,
          note: 'Ticket created',
        }),
      );

      for (const attachment of validatedAttachments) {
        await attachmentRepo.save(
          attachmentRepo.create({
            id: randomUUID(),
            ticketId: ticket.id,
            uploadedByUserId: userId,
            url: attachment.url,
            contentType: attachment.contentType,
          }),
        );
      }

      await this.notificationsService.safeEnqueueInTransaction(manager, {
        recipientUserId: userId,
        type: NotificationType.SUPPORT_TICKET_CREATED,
        title: 'Support ticket created',
        body: `Your ticket ${ticket.reference} has been submitted.`,
        data: {
          type: NotificationType.SUPPORT_TICKET_CREATED,
          ticketId: ticket.id,
          ticketReference: ticket.reference,
          event: 'CREATED',
        },
        idempotencyKey: `support-ticket-created:${ticket.id}`,
      });

      return ticket.id;
    });

    void relationRole;
    return this.getTicketForUser(userId, ticketId);
  }

  // ---------------------------------------------------------------------------
  // User list / detail / comment
  // ---------------------------------------------------------------------------

  async listTicketsForUser(
    userId: string,
    query: SupportTicketListQueryDto,
  ): Promise<SupportTicketPageDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.ticketRepository
      .createQueryBuilder('t')
      .where('t.user_id = :userId', { userId })
      .orderBy('t.updated_at', 'DESC')
      .addOrderBy('t.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.status) {
      qb.andWhere('t.status = :status', { status: query.status });
    }
    if (query.category) {
      qb.andWhere('t.category = :category', { category: query.category });
    }

    const [rows, total] = await qb.getManyAndCount();
    return {
      items: rows.map((row) => this.toListItem(row)),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async getTicketForUser(
    userId: string,
    ticketId: string,
  ): Promise<SupportTicketDetailDto> {
    const ticket = await this.ticketRepository.findOne({
      where: { id: ticketId, userId },
    });
    if (!ticket) {
      throw new SupportTicketNotFoundError();
    }
    return this.toDetail(ticket, { includeInternalComments: false });
  }

  async addUserComment(
    userId: string,
    ticketId: string,
    dto: AddSupportCommentDto,
  ): Promise<SupportCommentDto> {
    const ticket = await this.ticketRepository.findOne({
      where: { id: ticketId, userId },
    });
    if (!ticket) {
      throw new SupportTicketNotFoundError();
    }
    if (ticket.status === SupportTicketStatus.RESOLVED) {
      throw new SupportTicketResolvedError();
    }

    if (dto.idempotencyKey) {
      const existing = await this.commentRepository.findOne({
        where: { ticketId, idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        return this.toCommentDto(existing);
      }
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const commentRepo = manager.getRepository(SupportTicketComment);
      const ticketRepo = manager.getRepository(SupportTicket);

      if (dto.idempotencyKey) {
        const raced = await commentRepo.findOne({
          where: { ticketId, idempotencyKey: dto.idempotencyKey },
        });
        if (raced) {
          return raced;
        }
      }

      const comment = await commentRepo.save(
        commentRepo.create({
          id: randomUUID(),
          ticketId,
          authorUserId: userId,
          authorType: SupportCommentAuthorType.USER,
          message: dto.message,
          isInternal: false,
          idempotencyKey: dto.idempotencyKey?.trim() || null,
        }),
      );

      await ticketRepo.update({ id: ticketId }, { updatedAt: new Date() });
      return comment;
    });

    return this.toCommentDto(saved);
  }

  // ---------------------------------------------------------------------------
  // Admin APIs
  // ---------------------------------------------------------------------------

  async listTicketsForAdmin(query: AdminSupportTicketListQueryDto): Promise<{
    items: AdminSupportTicketListItemDto[];
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.ticketRepository
      .createQueryBuilder('t')
      .orderBy('t.updated_at', 'DESC')
      .addOrderBy('t.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.reference) {
      qb.andWhere('t.reference ILIKE :reference', {
        reference: `%${query.reference.trim()}%`,
      });
    }
    if (query.userId) {
      qb.andWhere('t.user_id = :userId', { userId: query.userId });
    }
    if (query.status) {
      qb.andWhere('t.status = :status', { status: query.status });
    }
    if (query.category) {
      qb.andWhere('t.category = :category', { category: query.category });
    }
    if (query.subcategory) {
      qb.andWhere('t.subcategory = :subcategory', {
        subcategory: query.subcategory.trim(),
      });
    }

    const [rows, total] = await qb.getManyAndCount();
    const names = await loadUserDisplayNamesByUserIds(
      this.profileRepository,
      rows.map((r) => r.userId),
    );

    return {
      items: rows.map((row) => ({
        ...this.toListItem(row),
        userId: row.userId,
        userName: names.get(row.userId) ?? null,
      })),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async getTicketForAdmin(ticketId: string): Promise<SupportTicketDetailDto> {
    const ticket = await this.ticketRepository.findOne({
      where: { id: ticketId },
    });
    if (!ticket) {
      throw new SupportTicketNotFoundError();
    }
    return this.toDetail(ticket, { includeInternalComments: true });
  }

  async updateStatus(
    adminUserId: string,
    ticketId: string,
    dto: UpdateSupportTicketStatusDto,
  ): Promise<SupportTicketDetailDto> {
    const result = await this.dataSource.transaction(async (manager) => {
      const ticketRepo = manager.getRepository(SupportTicket);
      const historyRepo = manager.getRepository(SupportTicketStatusHistory);

      const ticket = await ticketRepo.findOne({
        where: { id: ticketId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!ticket) {
        throw new SupportTicketNotFoundError();
      }

      if (ticket.status === dto.status) {
        return { ticket, changed: false as const };
      }

      const allowed = SUPPORT_STATUS_TRANSITIONS[ticket.status];
      if (!allowed.includes(dto.status)) {
        throw new SupportStatusTransitionError(
          `Cannot transition from ${ticket.status} to ${dto.status}`,
        );
      }

      const fromStatus = ticket.status;
      ticket.status = dto.status;
      if (dto.status === SupportTicketStatus.RESOLVED) {
        ticket.resolvedAt = new Date();
      }
      ticket.assigneeAdminUserId ??= adminUserId;
      await ticketRepo.save(ticket);

      await historyRepo.save(
        historyRepo.create({
          id: randomUUID(),
          ticketId: ticket.id,
          fromStatus,
          toStatus: dto.status,
          changedByUserId: adminUserId,
          changedByAdmin: true,
          note: `Status changed to ${dto.status}`,
        }),
      );

      const notificationType =
        dto.status === SupportTicketStatus.RESOLVED
          ? NotificationType.SUPPORT_TICKET_RESOLVED
          : NotificationType.SUPPORT_TICKET_IN_PROGRESS;

      const title =
        dto.status === SupportTicketStatus.RESOLVED
          ? 'Support ticket resolved'
          : 'Support ticket in progress';
      const body =
        dto.status === SupportTicketStatus.RESOLVED
          ? `Your ticket ${ticket.reference} has been resolved.`
          : `Your ticket ${ticket.reference} is now being reviewed.`;

      await this.notificationsService.safeEnqueueInTransaction(manager, {
        recipientUserId: ticket.userId,
        type: notificationType,
        title,
        body,
        data: {
          type: notificationType,
          ticketId: ticket.id,
          ticketReference: ticket.reference,
          event: dto.status,
        },
        idempotencyKey: `support-ticket-status:${ticket.id}:${dto.status}`,
      });

      return { ticket, changed: true as const, fromStatus };
    });

    if (result.changed) {
      await this.adminAlertService.recordActivity({
        eventType: 'SUPPORT_TICKET_STATUS_CHANGED',
        category: AdminAlertCategory.SYSTEM_HEALTH,
        severity: AdminAlertSeverity.INFO,
        title: `Support ticket ${result.ticket.reference}`,
        description: `Status changed to ${result.ticket.status}`,
        metadata: {
          ticketId: result.ticket.id,
          reference: result.ticket.reference,
          fromStatus: result.fromStatus,
          toStatus: result.ticket.status,
          adminUserId,
        },
      });
    }

    return this.getTicketForAdmin(ticketId);
  }

  async addAdminComment(
    adminUserId: string,
    ticketId: string,
    dto: AddSupportCommentDto,
  ): Promise<SupportCommentDto> {
    const ticket = await this.ticketRepository.findOne({
      where: { id: ticketId },
    });
    if (!ticket) {
      throw new SupportTicketNotFoundError();
    }

    if (dto.idempotencyKey) {
      const existing = await this.commentRepository.findOne({
        where: { ticketId, idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        return this.toCommentDto(existing);
      }
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const commentRepo = manager.getRepository(SupportTicketComment);
      const ticketRepo = manager.getRepository(SupportTicket);

      if (dto.idempotencyKey) {
        const raced = await commentRepo.findOne({
          where: { ticketId, idempotencyKey: dto.idempotencyKey },
        });
        if (raced) {
          return raced;
        }
      }

      const comment = await commentRepo.save(
        commentRepo.create({
          id: randomUUID(),
          ticketId,
          authorUserId: adminUserId,
          authorType: SupportCommentAuthorType.ADMIN,
          message: dto.message,
          isInternal: false,
          idempotencyKey: dto.idempotencyKey?.trim() || null,
        }),
      );

      await ticketRepo.update({ id: ticketId }, { updatedAt: new Date() });

      await this.notificationsService.safeEnqueueInTransaction(manager, {
        recipientUserId: ticket.userId,
        type: NotificationType.SUPPORT_TICKET_COMMENT,
        title: 'New support reply',
        body: `Support replied on ticket ${ticket.reference}.`,
        data: {
          type: NotificationType.SUPPORT_TICKET_COMMENT,
          ticketId: ticket.id,
          ticketReference: ticket.reference,
          commentId: comment.id,
          event: 'ADMIN_COMMENT',
        },
        idempotencyKey: `support-ticket-comment:${comment.id}`,
      });

      return comment;
    });

    await this.adminAlertService.recordActivity({
      eventType: 'SUPPORT_TICKET_ADMIN_COMMENT',
      category: AdminAlertCategory.SYSTEM_HEALTH,
      severity: AdminAlertSeverity.INFO,
      title: `Support reply on ${ticket.reference}`,
      description: 'Admin added a user-visible comment',
      metadata: {
        ticketId: ticket.id,
        reference: ticket.reference,
        commentId: saved.id,
        adminUserId,
      },
    });

    return this.toCommentDto(saved);
  }

  // ---------------------------------------------------------------------------
  // Eligibility helpers
  // ---------------------------------------------------------------------------

  private async resolveRideEligibility(
    userId: string,
    rideId: string,
  ): Promise<{
    ride: Ride;
    booking: Booking | null;
    role: SupportRideRelationRole;
  }> {
    const ride = await this.rideRepository.findOne({ where: { id: rideId } });
    if (!ride) {
      throw new SupportRideIneligibleError('Ride not found');
    }

    if (ride.driverId === userId) {
      if (
        ![...ACTIVE_RIDE_STATUSES, ...PAST_RIDE_STATUSES].includes(ride.status)
      ) {
        throw new SupportRideIneligibleError(
          `Ride status ${ride.status} is not eligible`,
        );
      }
      return { ride, booking: null, role: SupportRideRelationRole.DRIVER };
    }

    const bookings = await this.bookingRepository.find({
      where: {
        rideId,
        passengerId: userId,
        status: In([...ACTIVE_BOOKING_STATUSES, ...PAST_BOOKING_STATUSES]),
      },
      order: { createdAt: 'DESC' },
      take: 1,
    });
    const booking = bookings[0] ?? null;

    if (!booking) {
      throw new SupportRideForbiddenError();
    }

    return { ride, booking, role: SupportRideRelationRole.PASSENGER };
  }

  private assertCategorySubcategory(
    category: SupportTicketCategory,
    subcategory: string,
  ): void {
    const allowed = SUPPORT_CATEGORY_SUBCATEGORIES[category];
    if (!allowed?.includes(subcategory)) {
      throw new SupportInvalidCategoryError(
        `Subcategory ${subcategory} is not valid for ${category}`,
      );
    }
  }

  private buildSubject(
    category: SupportTicketCategory,
    subcategory: string,
  ): string {
    const label = `${category.replace(/_/g, ' ')} · ${subcategory.replace(/_/g, ' ')}`;
    return label.slice(0, SUPPORT_SUBJECT_MAX);
  }

  private async generateUniqueReference(): Promise<string> {
    for (let i = 0; i < 8; i++) {
      const suffix = randomBytes(4).toString('hex').toUpperCase();
      const reference = `SUP-${suffix}`;
      const exists = await this.ticketRepository.exists({
        where: { reference },
      });
      if (!exists) {
        return reference;
      }
    }
    return `SUP-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  }

  // ---------------------------------------------------------------------------
  // Mappers
  // ---------------------------------------------------------------------------

  private toEligibleRideDto(
    ride: Ride,
    booking: Booking | null,
    role: SupportRideRelationRole,
  ): EligibleSupportRideDto {
    return {
      rideId: ride.id,
      bookingId: booking?.id ?? null,
      role,
      source: ride.source,
      destination: ride.destination,
      departureDate: String(ride.departureDate).slice(0, 10),
      departureTime: String(ride.departureTime).slice(0, 8),
      rideStatus: ride.status,
      bookingStatus: booking?.status ?? null,
      rideType: ride.rideType,
    };
  }

  private toListItem(ticket: SupportTicket): SupportTicketListItemDto {
    return {
      id: ticket.id,
      reference: ticket.reference,
      category: ticket.category,
      subcategory: ticket.subcategory,
      subject: ticket.subject,
      status: ticket.status,
      relatedRideId: ticket.relatedRideId,
      relatedBookingId: ticket.relatedBookingId,
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
      resolvedAt: ticket.resolvedAt ? ticket.resolvedAt.toISOString() : null,
    };
  }

  private async toDetail(
    ticket: SupportTicket,
    opts: { includeInternalComments: boolean },
  ): Promise<SupportTicketDetailDto> {
    const [attachments, comments, history, relatedRide] = await Promise.all([
      this.attachmentRepository.find({
        where: { ticketId: ticket.id },
        order: { createdAt: 'ASC' },
      }),
      this.commentRepository.find({
        where: { ticketId: ticket.id },
        order: { createdAt: 'ASC' },
      }),
      this.historyRepository.find({
        where: { ticketId: ticket.id },
        order: { createdAt: 'ASC' },
      }),
      this.loadRelatedRideSummary(ticket),
    ]);

    const visibleComments = opts.includeInternalComments
      ? comments
      : comments.filter((c) => !c.isInternal);

    return {
      ...this.toListItem(ticket),
      description: ticket.description,
      relatedWalletTransactionId: ticket.relatedWalletTransactionId,
      attachments: attachments.map((a) => this.toAttachmentDto(a)),
      comments: visibleComments.map((c) => this.toCommentDto(c)),
      statusHistory: history.map((h) => this.toHistoryDto(h)),
      relatedRide,
    };
  }

  private async loadRelatedRideSummary(
    ticket: SupportTicket,
  ): Promise<SupportRelatedRideSummaryDto | null> {
    if (!ticket.relatedRideId) {
      return null;
    }
    const ride = await this.rideRepository.findOne({
      where: { id: ticket.relatedRideId },
    });
    if (!ride) {
      return null;
    }

    let role: SupportRideRelationRole | null = null;
    if (ride.driverId === ticket.userId) {
      role = SupportRideRelationRole.DRIVER;
    } else if (ticket.relatedBookingId) {
      role = SupportRideRelationRole.PASSENGER;
    }

    return {
      rideId: ride.id,
      bookingId: ticket.relatedBookingId,
      source: ride.source,
      destination: ride.destination,
      departureDate: String(ride.departureDate).slice(0, 10),
      departureTime: String(ride.departureTime).slice(0, 8),
      rideStatus: ride.status,
      role,
    };
  }

  private toAttachmentDto(row: SupportTicketAttachment): SupportAttachmentDto {
    return {
      id: row.id,
      url: row.url,
      contentType: row.contentType,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toCommentDto(row: SupportTicketComment): SupportCommentDto {
    return {
      id: row.id,
      authorType: row.authorType,
      authorUserId: row.authorUserId,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toHistoryDto(
    row: SupportTicketStatusHistory,
  ): SupportStatusHistoryDto {
    return {
      id: row.id,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      changedByAdmin: row.changedByAdmin,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    );
  }
}
