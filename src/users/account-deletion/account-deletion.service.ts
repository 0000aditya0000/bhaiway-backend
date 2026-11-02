import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { AdminAlertService } from '../../admin/admin-alert.service';
import {
  AdminAlertCategory,
  AdminAlertSeverity,
} from '../../admin/entities/admin-alert.entity';
import { maskEmail, maskPhone } from '../../admin/admin-privacy.util';
import { NotificationDevice } from '../../notifications/entities/notification-device.entity';
import { NotificationType } from '../../notifications/enums/notification.enums';
import { NotificationsService } from '../../notifications/notifications.service';
import { TrustedContact } from '../../safety/trusted-contacts/entities/trusted-contact.entity';
import { UserProfile } from '../entities/user-profile.entity';
import { User, UserStatus } from '../entities/user.entity';
import { resolveUserDisplayName } from '../user-display-name.util';
import { AccountDeletionEligibilityService } from './account-deletion-eligibility.service';
import {
  AdminAccountDeletionListQueryDto,
  AdminAccountDeletionPageDto,
  AdminAccountDeletionSortField,
} from './dto/admin-account-deletion.dto';
import { SubmitAccountDeletionDto } from './dto/submit-account-deletion.dto';
import { AccountDeletionAuditLog } from './entities/account-deletion-audit-log.entity';
import { AccountDeletionRequest } from './entities/account-deletion-request.entity';
import {
  AccountDeletionActorType,
  AccountDeletionAuditAction,
  AccountDeletionRequestStatus,
  ACTIVE_DELETION_REQUEST_STATUSES,
  DeletionReason,
} from './enums/account-deletion.enums';
import { calculateIndiaBusinessDays } from './utils/india-business-days.util';

@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly eligibilityService: AccountDeletionEligibilityService,
    private readonly notificationsService: NotificationsService,
    private readonly adminAlertService: AdminAlertService,
    @InjectRepository(AccountDeletionRequest)
    private readonly requestRepository: Repository<AccountDeletionRequest>,
    @InjectRepository(AccountDeletionAuditLog)
    private readonly auditLogRepository: Repository<AccountDeletionAuditLog>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserProfile)
    private readonly profileRepository: Repository<UserProfile>,
    @InjectRepository(NotificationDevice)
    private readonly deviceRepository: Repository<NotificationDevice>,
    @InjectRepository(TrustedContact)
    private readonly trustedContactRepository: Repository<TrustedContact>,
  ) {}

  // ---------------------------------------------------------------------------
  // User APIs
  // ---------------------------------------------------------------------------

  /**
   * Submits an account deletion request, atomically updates the account lifecycle
   * state to DELETION_REQUESTED, increments tokenVersion to revoke all active tokens,
   * records an audit log, and queues a user notification.
   */
  async submitRequest(userId: string, dto: SubmitAccountDeletionDto) {
    if (!dto.acceptedDeletionTerms) {
      throw new BadRequestException(
        'You must explicitly accept the account deletion terms.',
      );
    }

    const now = new Date();
    const responseDueAt = calculateIndiaBusinessDays(now, 7);

    // Initial eligibility evaluation (informational)
    const initialEligibility =
      await this.eligibilityService.checkEligibility(userId);

    const savedRequest = await this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const requestRepo = manager.getRepository(AccountDeletionRequest);
      const auditRepo = manager.getRepository(AccountDeletionAuditLog);

      const user = await userRepo
        .createQueryBuilder('u')
        .setLock('pessimistic_write')
        .where('u.id = :userId', { userId })
        .getOne();

      if (!user) {
        throw new NotFoundException('User not found');
      }

      if (user.status === UserStatus.DELETED) {
        throw new BadRequestException('Account has already been deleted');
      }

      // Check for any existing active deletion request
      const existingActive = await requestRepo
        .createQueryBuilder('r')
        .setLock('pessimistic_write')
        .where('r.userId = :userId', { userId })
        .andWhere('r.status IN (:...statuses)', {
          statuses: ACTIVE_DELETION_REQUEST_STATUSES,
        })
        .getOne();

      if (existingActive) {
        throw new ConflictException({
          statusCode: 409,
          code: 'ACTIVE_DELETION_REQUEST_EXISTS',
          message:
            'An active account deletion request is already open for this account.',
          error: 'Conflict',
        });
      }

      const request = requestRepo.create({
        userId,
        reason: dto.reason,
        additionalComment: dto.additionalComment?.trim() || null,
        status: AccountDeletionRequestStatus.PENDING,
        requestedAt: now,
        responseDueAt,
        userActionRequired: false,
        userActionMessage: null,
      });

      const saved = await requestRepo.save(request);

      // Transition user lifecycle state and bump tokenVersion to revoke full access tokens
      user.status = UserStatus.DELETION_REQUESTED;
      user.tokenVersion += 1;
      await userRepo.save(user);

      // Record audit log
      const audit = auditRepo.create({
        requestId: saved.id,
        userId,
        actorType: AccountDeletionActorType.USER,
        actorId: userId,
        action: AccountDeletionAuditAction.REQUEST_SUBMITTED,
        reason: dto.reason,
        metadata: {
          additionalComment: dto.additionalComment?.trim() || null,
          initialEligibility: {
            eligible: initialEligibility.eligible,
            blockersCount: initialEligibility.blockers.length,
          },
        },
      });
      await auditRepo.save(audit);

      return saved;
    });

    // Enqueue notification safely
    try {
      await this.notificationsService.enqueue({
        recipientUserId: userId,
        type: NotificationType.ACCOUNT_DELETION_REQUESTED,
        title: 'Account Deletion Request Received',
        body: 'We have received your account deletion request. Your account has been temporarily restricted while our team reviews it.',
        data: {
          type: NotificationType.ACCOUNT_DELETION_REQUESTED,
          requestId: savedRequest.id,
        },
        idempotencyKey: `account-deletion-requested:${savedRequest.id}`,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue deletion requested notification: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      success: true,
      request: {
        id: savedRequest.id,
        status: savedRequest.status,
        requestedAt: savedRequest.requestedAt,
        responseDueAt: savedRequest.responseDueAt,
      },
      message: 'Your account deletion request has been received.',
    };
  }

  /**
   * Returns current active deletion request status and details for mobile app.
   */
  async getStatus(userId: string) {
    const latestRequest = await this.requestRepository.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    if (!latestRequest) {
      return {
        hasActiveRequest: false,
        request: null,
      };
    }

    const hasActive = ACTIVE_DELETION_REQUEST_STATUSES.includes(
      latestRequest.status,
    );

    return {
      hasActiveRequest: hasActive,
      request: {
        id: latestRequest.id,
        status: latestRequest.status,
        reason: latestRequest.reason,
        requestedAt: latestRequest.requestedAt,
        responseDueAt: latestRequest.responseDueAt,
        userActionRequired: latestRequest.userActionRequired,
        userActionMessage: latestRequest.userActionMessage,
        canCancel:
          latestRequest.status !== AccountDeletionRequestStatus.COMPLETED &&
          latestRequest.status !== AccountDeletionRequestStatus.CANCELLED,
        isCompleted:
          latestRequest.status === AccountDeletionRequestStatus.COMPLETED,
      },
    };
  }

  /**
   * Cancels a pending, under-review, action-required, or approved deletion request.
   * Restores user status to ACTIVE, bumps tokenVersion, preserves all historical data,
   * and prevents race conditions with concurrent permanent deletion.
   */
  async cancelRequest(userId: string) {
    const result = await this.dataSource.transaction(async (manager) => {
      const requestRepo = manager.getRepository(AccountDeletionRequest);
      const userRepo = manager.getRepository(User);
      const auditRepo = manager.getRepository(AccountDeletionAuditLog);

      const request = await requestRepo
        .createQueryBuilder('r')
        .setLock('pessimistic_write')
        .where('r.userId = :userId', { userId })
        .andWhere('r.status IN (:...statuses)', {
          statuses: [
            ...ACTIVE_DELETION_REQUEST_STATUSES,
            AccountDeletionRequestStatus.COMPLETED,
            AccountDeletionRequestStatus.CANCELLED,
          ],
        })
        .orderBy('r.createdAt', 'DESC')
        .getOne();

      if (!request) {
        throw new NotFoundException('No account deletion request found');
      }

      if (request.status === AccountDeletionRequestStatus.COMPLETED) {
        throw new ConflictException({
          statusCode: 409,
          code: 'DELETION_ALREADY_COMPLETED',
          message:
            'Permanent account deletion has already been completed and cannot be cancelled.',
          error: 'Conflict',
        });
      }

      if (request.status === AccountDeletionRequestStatus.CANCELLED) {
        return { request, alreadyCancelled: true };
      }

      const user = await userRepo
        .createQueryBuilder('u')
        .setLock('pessimistic_write')
        .where('u.id = :userId', { userId })
        .getOne();

      if (!user) {
        throw new NotFoundException('User not found');
      }

      if (user.status === UserStatus.DELETED) {
        throw new ConflictException({
          statusCode: 409,
          code: 'USER_DELETED',
          message: 'Account has been deleted and cannot be restored.',
          error: 'Conflict',
        });
      }

      // Mark request cancelled
      request.status = AccountDeletionRequestStatus.CANCELLED;
      request.cancelledAt = new Date();
      await requestRepo.save(request);

      // Restore user to ACTIVE
      user.status = UserStatus.ACTIVE;
      user.tokenVersion += 1;
      await userRepo.save(user);

      // Record audit log
      const audit = auditRepo.create({
        requestId: request.id,
        userId,
        actorType: AccountDeletionActorType.USER,
        actorId: userId,
        action: AccountDeletionAuditAction.REQUEST_CANCELLED,
        metadata: {
          cancelledAt: request.cancelledAt,
        },
      });
      await auditRepo.save(audit);

      return { request, alreadyCancelled: false };
    });

    if (!result.alreadyCancelled) {
      try {
        await this.notificationsService.enqueue({
          recipientUserId: userId,
          type: NotificationType.ACCOUNT_DELETION_CANCELLED,
          title: 'Account Deletion Cancelled',
          body: 'Your account deletion request has been cancelled and full account access has been restored.',
          data: {
            type: NotificationType.ACCOUNT_DELETION_CANCELLED,
            requestId: result.request.id,
          },
          idempotencyKey: `account-deletion-cancelled:${result.request.id}`,
        });
      } catch (error) {
        this.logger.warn(
          `Failed to enqueue deletion cancelled notification: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return {
      success: true,
      message:
        'Your account deletion request has been cancelled and your account is active.',
    };
  }

  // ---------------------------------------------------------------------------
  // Admin APIs
  // ---------------------------------------------------------------------------

  /**
   * Admin paginated directory of account deletion requests.
   */
  async adminList(
    query: AdminAccountDeletionListQueryDto,
  ): Promise<AdminAccountDeletionPageDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sortBy = query.sortBy ?? AdminAccountDeletionSortField.REQUESTED_AT;
    const sortOrder = query.sortOrder ?? 'DESC';

    const qb = this.requestRepository
      .createQueryBuilder('r')
      .innerJoin(User, 'u', 'u.id = r.userId')
      .leftJoin(UserProfile, 'p', 'p.userId = u.id');

    if (query.status) {
      qb.andWhere('r.status = :status', { status: query.status });
    }

    if (query.dateFrom) {
      qb.andWhere('r.requestedAt >= :dateFrom', { dateFrom: query.dateFrom });
    }

    if (query.dateTo) {
      qb.andWhere('r.requestedAt <= :dateTo', { dateTo: query.dateTo });
    }

    if (query.search?.trim()) {
      const term = `%${query.search.trim().toLowerCase()}%`;
      qb.andWhere(
        `(CAST(r.id AS text) ILIKE :term
          OR CAST(u.id AS text) ILIKE :term
          OR LOWER(u.phone) LIKE :term
          OR LOWER(COALESCE(u.email, '')) LIKE :term
          OR LOWER(COALESCE(p.displayName, '')) LIKE :term
          OR LOWER(COALESCE(p.firstName, '')) LIKE :term
          OR LOWER(COALESCE(p.lastName, '')) LIKE :term)`,
        { term },
      );
    }

    const sortColumn =
      sortBy === AdminAccountDeletionSortField.RESPONSE_DUE_AT
        ? 'r.responseDueAt'
        : sortBy === AdminAccountDeletionSortField.CREATED_AT
          ? 'r.createdAt'
          : sortBy === AdminAccountDeletionSortField.STATUS
            ? 'r.status'
            : 'r.requestedAt';

    qb.orderBy(sortColumn, sortOrder);

    const total = await qb.getCount();

    interface AdminListRawRow {
      id: string;
      userId: string;
      userPhone: string;
      userEmail: string | null;
      userStatus: UserStatus;
      reason: DeletionReason;
      status: AccountDeletionRequestStatus;
      userActionRequired: boolean;
      requestedAt: Date | string;
      responseDueAt: Date | string;
      createdAt: Date | string;
      displayName: string | null;
      firstName: string | null;
      lastName: string | null;
    }

    const rawItems = await qb
      .select([
        'r.id AS id',
        'r.userId AS "userId"',
        'r.reason AS reason',
        'r.status AS status',
        'r.userActionRequired AS "userActionRequired"',
        'r.requestedAt AS "requestedAt"',
        'r.responseDueAt AS "responseDueAt"',
        'r.createdAt AS "createdAt"',
        'u.phone AS "userPhone"',
        'u.email AS "userEmail"',
        'u.status AS "userStatus"',
        'p.displayName AS "displayName"',
        'p.firstName AS "firstName"',
        'p.lastName AS "lastName"',
      ])
      .offset((page - 1) * limit)
      .limit(limit)
      .getRawMany<AdminListRawRow>();

    const items = rawItems.map((row) => ({
      id: row.id,
      userId: row.userId,
      userPhone: maskPhone(row.userPhone),
      userEmail: row.userEmail ? maskEmail(row.userEmail) : null,
      userDisplayName: resolveUserDisplayName({
        displayName: row.displayName,
        firstName: row.firstName ?? '',
        lastName: row.lastName,
      }),
      userStatus: row.userStatus,
      reason: row.reason,
      status: row.status,
      userActionRequired: Boolean(row.userActionRequired),
      requestedAt: new Date(row.requestedAt),
      responseDueAt: new Date(row.responseDueAt),
      createdAt: new Date(row.createdAt),
    }));

    // Status counts
    const statusCountsRaw = await this.requestRepository
      .createQueryBuilder('r')
      .select('r.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('r.status')
      .getRawMany<{ status: AccountDeletionRequestStatus; count: string }>();

    const statusCounts = {
      total: 0,
      pending: 0,
      underReview: 0,
      actionRequired: 0,
      approved: 0,
      completed: 0,
      cancelled: 0,
    };

    for (const row of statusCountsRaw) {
      const c = Number(row.count) || 0;
      statusCounts.total += c;
      if (row.status === AccountDeletionRequestStatus.PENDING)
        statusCounts.pending = c;
      if (row.status === AccountDeletionRequestStatus.UNDER_REVIEW)
        statusCounts.underReview = c;
      if (row.status === AccountDeletionRequestStatus.ACTION_REQUIRED)
        statusCounts.actionRequired = c;
      if (row.status === AccountDeletionRequestStatus.APPROVED)
        statusCounts.approved = c;
      if (row.status === AccountDeletionRequestStatus.COMPLETED)
        statusCounts.completed = c;
      if (row.status === AccountDeletionRequestStatus.CANCELLED)
        statusCounts.cancelled = c;
    }

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      statusCounts,
    };
  }

  /**
   * Detailed request view for admin, including user info, live eligibility blockers,
   * and complete audit history.
   */
  async adminGetDetail(requestId: string) {
    const request = await this.requestRepository.findOne({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ACCOUNT_DELETION_REQUEST_NOT_FOUND',
        message: 'Account deletion request not found',
        error: 'Not Found',
      });
    }

    const user = await this.userRepository.findOne({
      where: { id: request.userId },
    });
    const profile = await this.profileRepository.findOne({
      where: { userId: request.userId },
    });

    const eligibility = await this.eligibilityService.checkEligibility(
      request.userId,
    );

    const auditLogs = await this.auditLogRepository.find({
      where: { requestId },
      order: { createdAt: 'ASC' },
    });

    return {
      request: {
        id: request.id,
        userId: request.userId,
        reason: request.reason,
        additionalComment: request.additionalComment,
        status: request.status,
        requestedAt: request.requestedAt,
        reviewedAt: request.reviewedAt,
        responseDueAt: request.responseDueAt,
        adminId: request.adminId,
        adminNote: request.adminNote,
        userActionRequired: request.userActionRequired,
        userActionMessage: request.userActionMessage,
        approvedAt: request.approvedAt,
        completedAt: request.completedAt,
        cancelledAt: request.cancelledAt,
        cancellationReason: request.cancellationReason,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      },
      user: user
        ? {
            id: user.id,
            phone: user.phone,
            maskedPhone: maskPhone(user.phone),
            email: user.email,
            maskedEmail: user.email ? maskEmail(user.email) : null,
            status: user.status,
            createdAt: user.createdAt,
            profile: profile
              ? {
                  firstName: profile.firstName,
                  lastName: profile.lastName,
                  displayName: resolveUserDisplayName(profile),
                  gender: profile.gender,
                  dateOfBirth: profile.dateOfBirth,
                  profilePhoto: profile.profilePhoto,
                }
              : null,
          }
        : null,
      eligibility,
      auditLogs,
    };
  }

  /**
   * Starts admin review: transitions PENDING to UNDER_REVIEW.
   */
  async adminReview(
    requestId: string,
    adminUserId: string,
    adminNote?: string,
  ) {
    const updated = await this.dataSource.transaction(async (manager) => {
      const requestRepo = manager.getRepository(AccountDeletionRequest);
      const auditRepo = manager.getRepository(AccountDeletionAuditLog);

      const request = await requestRepo
        .createQueryBuilder('r')
        .setLock('pessimistic_write')
        .where('r.id = :id', { id: requestId })
        .getOne();

      if (!request) {
        throw new NotFoundException('Account deletion request not found');
      }

      if (request.status === AccountDeletionRequestStatus.CANCELLED) {
        throw new ConflictException(
          'Cannot review a cancelled account deletion request',
        );
      }

      if (request.status === AccountDeletionRequestStatus.COMPLETED) {
        throw new ConflictException(
          'Account deletion has already been completed',
        );
      }

      request.status = AccountDeletionRequestStatus.UNDER_REVIEW;
      request.reviewedAt = new Date();
      request.adminId = adminUserId;
      if (adminNote) {
        request.adminNote = adminNote;
      }

      const saved = await requestRepo.save(request);

      const audit = auditRepo.create({
        requestId: saved.id,
        userId: saved.userId,
        actorType: AccountDeletionActorType.ADMIN,
        actorId: adminUserId,
        action: AccountDeletionAuditAction.REVIEW_STARTED,
        metadata: {
          adminNote: adminNote || null,
        },
      });
      await auditRepo.save(audit);

      return saved;
    });

    await this.adminAlertService.recordActivity({
      eventType: 'ACCOUNT_DELETION_REVIEW_STARTED',
      category: AdminAlertCategory.SECURITY,
      severity: AdminAlertSeverity.INFO,
      title: 'Account deletion review started',
      description: `Admin ${adminUserId} started review of deletion request ${requestId}`,
      metadata: {
        requestId,
        targetUserId: updated.userId,
        adminUserId,
      },
    });

    return updated;
  }

  /**
   * Requests user action: transitions status to ACTION_REQUIRED, updates user lifecycle
   * state to DELETION_ACTION_REQUIRED, and enqueues notification with the action message.
   */
  async adminRequestUserAction(
    requestId: string,
    adminUserId: string,
    userMessage: string,
    adminNote?: string,
  ) {
    if (!userMessage?.trim()) {
      throw new BadRequestException('User action message is required');
    }

    const { updated, userId } = await this.dataSource.transaction(
      async (manager) => {
        const requestRepo = manager.getRepository(AccountDeletionRequest);
        const userRepo = manager.getRepository(User);
        const auditRepo = manager.getRepository(AccountDeletionAuditLog);

        const request = await requestRepo
          .createQueryBuilder('r')
          .setLock('pessimistic_write')
          .where('r.id = :id', { id: requestId })
          .getOne();

        if (!request) {
          throw new NotFoundException('Account deletion request not found');
        }

        if (
          request.status === AccountDeletionRequestStatus.COMPLETED ||
          request.status === AccountDeletionRequestStatus.CANCELLED
        ) {
          throw new ConflictException(
            `Cannot request user action on a ${request.status} deletion request`,
          );
        }

        const user = await userRepo
          .createQueryBuilder('u')
          .setLock('pessimistic_write')
          .where('u.id = :userId', { userId: request.userId })
          .getOne();

        if (!user || user.status === UserStatus.DELETED) {
          throw new ConflictException('User account is invalid or deleted');
        }

        request.status = AccountDeletionRequestStatus.ACTION_REQUIRED;
        request.userActionRequired = true;
        request.userActionMessage = userMessage.trim();
        request.adminId = adminUserId;
        if (adminNote) {
          request.adminNote = adminNote;
        }

        const saved = await requestRepo.save(request);

        user.status = UserStatus.DELETION_ACTION_REQUIRED;
        await userRepo.save(user);

        const audit = auditRepo.create({
          requestId: saved.id,
          userId: saved.userId,
          actorType: AccountDeletionActorType.ADMIN,
          actorId: adminUserId,
          action: AccountDeletionAuditAction.USER_ACTION_REQUESTED,
          reason: userMessage.trim(),
          metadata: {
            adminNote: adminNote || null,
          },
        });
        await auditRepo.save(audit);

        return { updated: saved, userId: user.id };
      },
    );

    // Enqueue notification safely
    try {
      await this.notificationsService.enqueue({
        recipientUserId: userId,
        type: NotificationType.ACCOUNT_DELETION_ACTION_REQUIRED,
        title: 'Action Required: Account Deletion',
        body: userMessage.trim(),
        data: {
          type: NotificationType.ACCOUNT_DELETION_ACTION_REQUIRED,
          requestId,
        },
        idempotencyKey: `account-deletion-action-required:${requestId}:${Date.now()}`,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue action required notification: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await this.adminAlertService.recordActivity({
      eventType: 'ACCOUNT_DELETION_ACTION_REQUESTED',
      category: AdminAlertCategory.SECURITY,
      severity: AdminAlertSeverity.WARNING,
      title: 'User action requested for account deletion',
      description: `Admin requested action from user ${userId} for deletion request ${requestId}`,
      metadata: {
        requestId,
        targetUserId: userId,
        adminUserId,
        message: userMessage,
      },
    });

    return updated;
  }

  /**
   * Approves deletion request if there are zero outstanding blockers.
   * Updates status to APPROVED and user state to DELETION_APPROVED.
   * Does NOT execute permanent deletion yet.
   */
  async adminApprove(
    requestId: string,
    adminUserId: string,
    adminNote?: string,
  ) {
    const { updated, userId } = await this.dataSource.transaction(
      async (manager) => {
        const requestRepo = manager.getRepository(AccountDeletionRequest);
        const userRepo = manager.getRepository(User);
        const auditRepo = manager.getRepository(AccountDeletionAuditLog);

        const request = await requestRepo
          .createQueryBuilder('r')
          .setLock('pessimistic_write')
          .where('r.id = :id', { id: requestId })
          .getOne();

        if (!request) {
          throw new NotFoundException('Account deletion request not found');
        }

        if (request.status === AccountDeletionRequestStatus.APPROVED) {
          return { updated: request, userId: request.userId };
        }

        if (
          request.status === AccountDeletionRequestStatus.COMPLETED ||
          request.status === AccountDeletionRequestStatus.CANCELLED
        ) {
          throw new ConflictException(
            `Cannot approve a ${request.status} deletion request`,
          );
        }

        const user = await userRepo
          .createQueryBuilder('u')
          .setLock('pessimistic_write')
          .where('u.id = :userId', { userId: request.userId })
          .getOne();

        if (!user || user.status === UserStatus.DELETED) {
          throw new ConflictException('User is not available or deleted');
        }

        // Live eligibility check inside transaction
        const eligibility = await this.eligibilityService.checkEligibility(
          user.id,
          manager,
        );

        if (!eligibility.eligible) {
          throw new BadRequestException({
            statusCode: 400,
            code: 'OUTSTANDING_OBLIGATIONS_BLOCK_APPROVAL',
            message:
              'Cannot approve deletion request while outstanding obligations exist.',
            blockers: eligibility.blockers,
            error: 'Bad Request',
          });
        }

        request.status = AccountDeletionRequestStatus.APPROVED;
        request.approvedAt = new Date();
        request.adminId = adminUserId;
        request.userActionRequired = false;
        if (adminNote) {
          request.adminNote = adminNote;
        }

        const saved = await requestRepo.save(request);

        user.status = UserStatus.DELETION_APPROVED;
        await userRepo.save(user);

        const audit = auditRepo.create({
          requestId: saved.id,
          userId: saved.userId,
          actorType: AccountDeletionActorType.ADMIN,
          actorId: adminUserId,
          action: AccountDeletionAuditAction.REQUEST_APPROVED,
          metadata: {
            adminNote: adminNote || null,
          },
        });
        await auditRepo.save(audit);

        return { updated: saved, userId: user.id };
      },
    );

    // Enqueue notification safely
    try {
      await this.notificationsService.enqueue({
        recipientUserId: userId,
        type: NotificationType.ACCOUNT_DELETION_APPROVED,
        title: 'Account Deletion Approved',
        body: 'Your account deletion has been approved and will be permanently processed shortly.',
        data: {
          type: NotificationType.ACCOUNT_DELETION_APPROVED,
          requestId,
        },
        idempotencyKey: `account-deletion-approved:${requestId}`,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue deletion approved notification: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await this.adminAlertService.recordActivity({
      eventType: 'ACCOUNT_DELETION_APPROVED',
      category: AdminAlertCategory.SECURITY,
      severity: AdminAlertSeverity.INFO,
      title: 'Account deletion approved',
      description: `Admin approved deletion request ${requestId} for user ${userId}`,
      metadata: {
        requestId,
        targetUserId: userId,
        adminUserId,
      },
    });

    return updated;
  }

  /**
   * Executes controlled, auditable permanent deletion.
   *
   * Verifications inside transaction:
   * 1. Lock user and request rows.
   * 2. Confirm request status is APPROVED.
   * 3. Confirm user has not cancelled (user status is DELETION_APPROVED).
   * 4. Re-run eligibility checker inside transaction.
   * 5. Anonymize personal data (profile, release phone, clear email).
   * 6. Deactivate FCM devices & clear personal trusted contacts.
   * 7. Maintain referential integrity for financial ledger and historical safety records.
   * 8. Mark user DELETED and bump tokenVersion.
   * 9. Mark request COMPLETED.
   * 10. Audit event recorded.
   */
  async adminComplete(
    requestId: string,
    adminUserId: string,
    adminNote?: string,
  ) {
    const result = await this.dataSource.transaction(async (manager) => {
      const requestRepo = manager.getRepository(AccountDeletionRequest);
      const userRepo = manager.getRepository(User);
      const auditRepo = manager.getRepository(AccountDeletionAuditLog);
      const deviceRepo = manager.getRepository(NotificationDevice);

      // Lock request
      const request = await requestRepo
        .createQueryBuilder('r')
        .setLock('pessimistic_write')
        .where('r.id = :id', { id: requestId })
        .getOne();

      if (!request) {
        throw new NotFoundException('Account deletion request not found');
      }

      if (request.status === AccountDeletionRequestStatus.COMPLETED) {
        throw new ConflictException({
          statusCode: 409,
          code: 'DELETION_ALREADY_COMPLETED',
          message: 'Account deletion has already been completed.',
          error: 'Conflict',
        });
      }

      if (request.status === AccountDeletionRequestStatus.CANCELLED) {
        throw new ConflictException({
          statusCode: 409,
          code: 'REQUEST_CANCELLED',
          message: 'The user has cancelled this account deletion request.',
          error: 'Conflict',
        });
      }

      if (request.status !== AccountDeletionRequestStatus.APPROVED) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'REQUEST_NOT_APPROVED',
          message:
            'Account deletion request must be APPROVED before permanent deletion can be completed.',
          error: 'Bad Request',
        });
      }

      // Lock user
      const user = await userRepo
        .createQueryBuilder('u')
        .setLock('pessimistic_write')
        .where('u.id = :userId', { userId: request.userId })
        .getOne();

      if (!user) {
        throw new NotFoundException('User not found');
      }

      if (user.status !== UserStatus.DELETION_APPROVED) {
        throw new ConflictException({
          statusCode: 409,
          code: 'USER_NOT_IN_APPROVED_STATE',
          message:
            'User is no longer in approved deletion state. They may have cancelled.',
          error: 'Conflict',
        });
      }

      // Re-run eligibility check with row-level locks
      const eligibility = await this.eligibilityService.checkEligibility(
        user.id,
        manager,
      );

      if (!eligibility.eligible) {
        // Record audit that completion was blocked
        const blockedAudit = auditRepo.create({
          requestId: request.id,
          userId: user.id,
          actorType: AccountDeletionActorType.ADMIN,
          actorId: adminUserId,
          action: AccountDeletionAuditAction.COMPLETION_BLOCKED,
          reason:
            'Outstanding obligations detected immediately prior to completion',
          metadata: {
            blockers: eligibility.blockers,
          },
        });
        await auditRepo.save(blockedAudit);

        throw new BadRequestException({
          statusCode: 400,
          code: 'PERMANENT_DELETION_BLOCKED',
          message:
            'Permanent deletion blocked: new or unresolved obligations detected.',
          blockers: eligibility.blockers,
          error: 'Bad Request',
        });
      }

      // -----------------------------------------------------------------------
      // DATA RETENTION & PERMANENT ACCOUNT CLOSURE (Zero Destruction / Zero Anonymization)
      // -----------------------------------------------------------------------

      // 1. All original personal, profile, KYC, ride, booking, wallet, ledger,
      // safety, and contact data are preserved intact in the database without
      // physical deletion, anonymization, masking, overwriting, or nullification.

      // 2. Disable push notification delivery by deactivating devices,
      // while retaining all original device and token records.
      await deviceRepo.update({ userId: user.id }, { isActive: false });

      // 3. Mark user status as DELETED and bump tokenVersion to
      // immediately invalidate all existing access tokens and sessions.
      // Phone, email, referralCode, profile, and all historical records remain untouched.
      user.status = UserStatus.DELETED;
      user.tokenVersion += 1;
      await userRepo.save(user);

      // 4. Update request status to COMPLETED
      request.status = AccountDeletionRequestStatus.COMPLETED;
      request.completedAt = new Date();
      request.adminId = adminUserId;
      if (adminNote) {
        request.adminNote = adminNote;
      }
      await requestRepo.save(request);

      // 5. Record immutable audit log
      const audit = auditRepo.create({
        requestId: request.id,
        userId: user.id,
        actorType: AccountDeletionActorType.ADMIN,
        actorId: adminUserId,
        action: AccountDeletionAuditAction.DELETION_COMPLETED,
        metadata: {
          adminNote: adminNote || null,
        },
      });
      await auditRepo.save(audit);

      return { request, user };
    });

    await this.adminAlertService.recordActivity({
      eventType: 'ACCOUNT_DELETION_COMPLETED',
      category: AdminAlertCategory.SECURITY,
      severity: AdminAlertSeverity.INFO,
      title: 'Account permanently deleted',
      description: `Permanent deletion completed for user ${result.user.id} by admin ${adminUserId}`,
      metadata: {
        requestId,
        targetUserId: result.user.id,
        adminUserId,
      },
    });

    return {
      success: true,
      message: 'Account deletion has been permanently completed.',
      request: {
        id: result.request.id,
        status: result.request.status,
        completedAt: result.request.completedAt,
      },
    };
  }
}
