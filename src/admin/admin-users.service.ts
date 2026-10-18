import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { BookingStatus } from '../bookings/enums/booking.enums';
import { CorporateIdentityVerification } from '../corporate-identity/entities/corporate-identity-verification.entity';
import { CorporateIdentityStatus } from '../corporate-identity/enums/corporate-identity-status.enum';
import { RatingsService } from '../ratings/ratings.service';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus } from '../rides/enums/ride.enums';
import { UserProfile } from '../users/entities/user-profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { resolveUserDisplayName } from '../users/user-display-name.util';
import { UserDriverEarningsService } from '../users/user-driver-earnings.service';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { UserVerification } from '../verification/entities/user-verification.entity';
import {
  VerificationStatus,
  VerificationType,
} from '../verification/enums/verification.enums';
import { Wallet } from '../wallet/entities/wallet.entity';
import { PLATFORM_USER_ID } from '../wallet/platform-wallet.constants';
import { WalletQueryService } from '../wallet/wallet-query.service';
import { AdminAlertService } from './admin-alert.service';
import { ADMIN_BOOTSTRAP_USER_ID } from './admin.constants';
import { maskEmail, maskPhone } from './admin-privacy.util';
import { mapAdminVerificationBundle } from './admin-verification.mapper';
import {
  AdminAlertCategory,
  AdminAlertSeverity,
} from './entities/admin-alert.entity';
import {
  AdminRestrictionReasonDto,
  AdminSuspendUserDto,
  AdminUserDirectorySummaryDto,
  AdminUserListItemDto,
  AdminUserListQueryDto,
  AdminUserPageDto,
  AdminUserSortField,
  AdminUserTypeFilter,
} from './dto/admin-user.dto';

const EXCLUDED_USER_IDS = [PLATFORM_USER_ID, ADMIN_BOOTSTRAP_USER_ID];

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly adminAlertService: AdminAlertService,
    private readonly walletQueryService: WalletQueryService,
    private readonly ratingsService: RatingsService,
    private readonly driverEarningsService: UserDriverEarningsService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserProfile)
    private readonly profileRepository: Repository<UserProfile>,
    @InjectRepository(UserVerification)
    private readonly verificationRepository: Repository<UserVerification>,
    @InjectRepository(CorporateIdentityVerification)
    private readonly corporateRepository: Repository<CorporateIdentityVerification>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepository: Repository<Vehicle>,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
  ) {}

  async list(query: AdminUserListQueryDto): Promise<AdminUserPageDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sortBy = query.sortBy ?? AdminUserSortField.CREATED_AT;
    const sortOrder = query.sortOrder ?? 'DESC';

    const qb = this.userRepository
      .createQueryBuilder('u')
      .leftJoin(UserProfile, 'p', 'p.user_id = u.id')
      .where('u.id NOT IN (:...excluded)', { excluded: EXCLUDED_USER_IDS });

    if (query.status) {
      qb.andWhere('u.status = :status', { status: query.status });
    }

    if (query.search?.trim()) {
      const term = `%${query.search.trim().toLowerCase()}%`;
      qb.andWhere(
        `(CAST(u.id AS text) ILIKE :term
          OR LOWER(u.phone) LIKE :term
          OR LOWER(COALESCE(u.email, '')) LIKE :term
          OR LOWER(COALESCE(p.display_name, '')) LIKE :term
          OR LOWER(COALESCE(p.first_name, '')) LIKE :term
          OR LOWER(COALESCE(p.last_name, '')) LIKE :term)`,
        { term },
      );
    }

    if (query.governmentIdStatus) {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM user_verifications uv
          WHERE uv.user_id = u.id
            AND uv.is_current = true
            AND uv.verification_type = :identityType
            AND uv.status = :govStatus
        )`,
        {
          identityType: VerificationType.IDENTITY,
          govStatus: query.governmentIdStatus,
        },
      );
    }

    if (query.corporateStatus?.trim()) {
      const corp = query.corporateStatus.trim().toUpperCase();
      if (corp === 'NOT_VERIFIED') {
        qb.andWhere(
          `(NOT EXISTS (
              SELECT 1 FROM corporate_identity_verifications c
              WHERE c.user_id = u.id
            )
            OR EXISTS (
              SELECT 1 FROM corporate_identity_verifications c
              WHERE c.user_id = u.id AND c.status = :corpStatus
            ))`,
          { corpStatus: CorporateIdentityStatus.NOT_VERIFIED },
        );
      } else {
        qb.andWhere(
          `EXISTS (
            SELECT 1 FROM corporate_identity_verifications c
            WHERE c.user_id = u.id AND c.status = :corpStatus
          )`,
          { corpStatus: corp },
        );
      }
    }

    if (query.userType && query.userType !== AdminUserTypeFilter.ALL) {
      const isDriverSql = this.driverExistenceSql('u.id');
      const isRiderSql = `EXISTS (
        SELECT 1 FROM bookings b WHERE b.passenger_id = u.id
      )`;
      if (query.userType === AdminUserTypeFilter.BOTH) {
        qb.andWhere(`(${isDriverSql}) AND (${isRiderSql})`);
      } else if (query.userType === AdminUserTypeFilter.DRIVER) {
        qb.andWhere(`(${isDriverSql}) AND NOT (${isRiderSql})`);
      } else if (query.userType === AdminUserTypeFilter.RIDER) {
        qb.andWhere(`NOT (${isDriverSql})`);
      }
    }

    const sortColumn =
      sortBy === AdminUserSortField.LAST_LOGIN_AT
        ? 'u.last_login_at'
        : sortBy === AdminUserSortField.STATUS
          ? 'u.status'
          : 'u.created_at';
    qb.orderBy(sortColumn, sortOrder).addOrderBy('u.id', 'DESC');

    const total = await qb.getCount();
    const users = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    const [summary, items] = await Promise.all([
      this.buildSummary(),
      this.mapUserListItems(users),
    ]);

    return {
      summary,
      items,
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async getDetail(userId: string) {
    this.assertNotSystemUser(userId);
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ADMIN_USER_NOT_FOUND',
        message: 'User not found',
        error: 'Not Found',
      });
    }

    const [
      profile,
      verifications,
      corporate,
      walletEntity,
      walletBalance,
      ratings,
      rideStats,
      driverEarnings,
      vehicles,
    ] = await Promise.all([
      this.profileRepository.findOne({ where: { userId } }),
      this.verificationRepository.find({
        where: { userId, isCurrent: true },
      }),
      this.corporateRepository.findOne({ where: { userId } }),
      this.walletRepository.findOne({ where: { userId } }),
      this.walletQueryService.getBalanceForUser(userId).catch(() => null),
      this.ratingsService.getUserRatingRoleAverages(userId),
      this.loadUserRideStats(userId),
      this.driverEarningsService.getLifetimeEarningsByRideType(userId),
      this.vehicleRepository.find({
        where: { userId },
        withDeleted: false,
        order: { createdAt: 'DESC' },
      }),
    ]);

    const verificationByType = new Map(
      verifications.map((v) => [v.verificationType, v] as const),
    );
    const identity = verificationByType.get(VerificationType.IDENTITY);

    const isDriver = await this.isDriverUser(userId);
    const isRider = await this.isRiderUser(userId);
    const userType =
      isDriver && isRider ? 'BOTH' : isDriver ? 'DRIVER' : 'RIDER';

    return {
      id: user.id,
      displayName: resolveUserDisplayName(profile),
      firstName: profile?.firstName ?? null,
      lastName: profile?.lastName ?? null,
      phone: user.phone,
      email: user.email,
      emailVerified: user.emailVerified,
      phoneVerified: user.phoneVerified,
      gender: profile?.gender ?? null,
      dateOfBirth: profile?.dateOfBirth ?? null,
      profilePhoto: profile?.profilePhoto ?? null,
      status: user.status,
      userType,
      bookingRestricted: user.bookingRestricted,
      bookingRestrictedReason: user.bookingRestrictedReason,
      ridePublishRestricted: user.ridePublishRestricted,
      ridePublishRestrictedReason: user.ridePublishRestrictedReason,
      suspensionReason: user.suspensionReason,
      suspendedAt: user.suspendedAt ? user.suspendedAt.toISOString() : null,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      lastActiveAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      rating:
        ratings.overall.totalRatings > 0 ? ratings.overall.averageRating : null,
      ratings,
      verification: mapAdminVerificationBundle(verifications, corporate),
      rides: {
        semantics:
          'passengerCompletedBookings = COMPLETED bookings as passenger; driverCompletedRides = COMPLETED rides as driver; totalRides = sum of both (a user may appear in both)',
        passengerCompletedBookings: rideStats.passengerCompleted,
        driverCompletedRides: rideStats.driverCompleted,
        totalRides: rideStats.passengerCompleted + rideStats.driverCompleted,
      },
      wallet: walletBalance
        ? {
            status: walletEntity?.status ?? null,
            ...walletBalance,
          }
        : null,
      driverEarnings,
      vehicles: vehicles.map((v) => ({
        id: v.id,
        registrationNumber: v.registrationNumber,
        make: v.make,
        model: v.model,
        variant: v.variant,
        vehicleType: v.vehicleType,
        color: v.color,
        seatingCapacity: v.seatingCapacity,
        registrationYear: v.registrationYear,
        documentUrl: v.documentUrl,
        documentType: v.documentType,
        documentReference: v.documentReference,
        isActive: v.isActive,
        createdAt: v.createdAt.toISOString(),
        updatedAt: v.updatedAt.toISOString(),
      })),
      activity: this.buildActivityTimeline(user, identity, corporate),
      safety: {
        available: false,
        note: 'No admin-accessible SOS/safety incident directory is implemented in this backend yet.',
      },
    };
  }

  async suspend(adminUserId: string, userId: string, dto: AdminSuspendUserDto) {
    this.assertNotSystemUser(userId);
    if (userId === adminUserId) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'ADMIN_CANNOT_SUSPEND_SELF',
        message: 'Administrators cannot suspend their own account',
        error: 'Bad Request',
      });
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(User);
      const user = await repo
        .createQueryBuilder('u')
        .setLock('pessimistic_write')
        .where('u.id = :userId', { userId })
        .getOne();
      if (!user) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'ADMIN_USER_NOT_FOUND',
          message: 'User not found',
          error: 'Not Found',
        });
      }
      if (user.status === UserStatus.SUSPENDED) {
        throw new ConflictException({
          statusCode: 409,
          code: 'USER_ALREADY_SUSPENDED',
          message: 'User is already suspended',
          error: 'Conflict',
        });
      }

      const previousStatus = user.status;
      user.status = UserStatus.SUSPENDED;
      user.suspensionReason = dto.reason;
      user.suspendedAt = new Date();
      user.tokenVersion += 1;
      await repo.save(user);
      return { user, previousStatus };
    });

    await this.adminAlertService.recordActivity({
      eventType: 'USER_SUSPENDED',
      category: AdminAlertCategory.SECURITY,
      severity: AdminAlertSeverity.WARNING,
      title: 'User suspended',
      description: `User ${userId} suspended`,
      metadata: {
        targetUserId: userId,
        adminUserId,
        reason: dto.reason,
        previousStatus: result.previousStatus,
        newStatus: UserStatus.SUSPENDED,
        tokenVersion: result.user.tokenVersion,
      },
    });

    return this.getDetail(userId);
  }

  async unsuspend(adminUserId: string, userId: string) {
    this.assertNotSystemUser(userId);

    const result = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(User);
      const user = await repo
        .createQueryBuilder('u')
        .setLock('pessimistic_write')
        .where('u.id = :userId', { userId })
        .getOne();
      if (!user) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'ADMIN_USER_NOT_FOUND',
          message: 'User not found',
          error: 'Not Found',
        });
      }
      if (user.status !== UserStatus.SUSPENDED) {
        throw new ConflictException({
          statusCode: 409,
          code: 'USER_NOT_SUSPENDED',
          message: 'User is not suspended',
          error: 'Conflict',
        });
      }

      user.status = UserStatus.ACTIVE;
      user.suspensionReason = null;
      user.suspendedAt = null;
      // Bump token version so pre-suspension tokens remain invalid after unsuspend.
      user.tokenVersion += 1;
      await repo.save(user);
      return user;
    });

    await this.adminAlertService.recordActivity({
      eventType: 'USER_UNSUSPENDED',
      category: AdminAlertCategory.SECURITY,
      severity: AdminAlertSeverity.INFO,
      title: 'User unsuspended',
      description: `User ${userId} unsuspended`,
      metadata: {
        targetUserId: userId,
        adminUserId,
        newStatus: UserStatus.ACTIVE,
        tokenVersion: result.tokenVersion,
      },
    });

    return this.getDetail(userId);
  }

  async restrictBooking(
    adminUserId: string,
    userId: string,
    dto: AdminRestrictionReasonDto,
  ) {
    return this.setRestriction(
      adminUserId,
      userId,
      'booking',
      true,
      dto.reason,
    );
  }

  async clearBookingRestriction(adminUserId: string, userId: string) {
    return this.setRestriction(adminUserId, userId, 'booking', false, null);
  }

  async restrictRidePublishing(
    adminUserId: string,
    userId: string,
    dto: AdminRestrictionReasonDto,
  ) {
    return this.setRestriction(
      adminUserId,
      userId,
      'ridePublish',
      true,
      dto.reason,
    );
  }

  async clearRidePublishingRestriction(adminUserId: string, userId: string) {
    return this.setRestriction(adminUserId, userId, 'ridePublish', false, null);
  }

  private async setRestriction(
    adminUserId: string,
    userId: string,
    kind: 'booking' | 'ridePublish',
    restricted: boolean,
    reason: string | null | undefined,
  ) {
    this.assertNotSystemUser(userId);

    const user = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(User);
      const locked = await repo
        .createQueryBuilder('u')
        .setLock('pessimistic_write')
        .where('u.id = :userId', { userId })
        .getOne();
      if (!locked) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'ADMIN_USER_NOT_FOUND',
          message: 'User not found',
          error: 'Not Found',
        });
      }

      if (kind === 'booking') {
        locked.bookingRestricted = restricted;
        locked.bookingRestrictedReason = restricted
          ? reason?.trim() || null
          : null;
      } else {
        locked.ridePublishRestricted = restricted;
        locked.ridePublishRestrictedReason = restricted
          ? reason?.trim() || null
          : null;
      }
      await repo.save(locked);
      return locked;
    });

    await this.adminAlertService.recordActivity({
      eventType: restricted
        ? kind === 'booking'
          ? 'USER_BOOKING_RESTRICTED'
          : 'USER_RIDE_PUBLISH_RESTRICTED'
        : kind === 'booking'
          ? 'USER_BOOKING_RESTRICTION_CLEARED'
          : 'USER_RIDE_PUBLISH_RESTRICTION_CLEARED',
      category: AdminAlertCategory.SECURITY,
      severity: AdminAlertSeverity.INFO,
      title: restricted
        ? `${kind} restriction applied`
        : `${kind} restriction cleared`,
      description: `User ${userId}`,
      metadata: {
        targetUserId: userId,
        adminUserId,
        kind,
        restricted,
        reason: reason ?? null,
      },
    });

    return {
      id: user.id,
      bookingRestricted: user.bookingRestricted,
      bookingRestrictedReason: user.bookingRestrictedReason,
      ridePublishRestricted: user.ridePublishRestricted,
      ridePublishRestrictedReason: user.ridePublishRestrictedReason,
      status: user.status,
    };
  }

  private async buildSummary(): Promise<AdminUserDirectorySummaryDto> {
    const [totalUsers, activeUsers, drivers, riders] = await Promise.all([
      this.userRepository
        .createQueryBuilder('u')
        .where('u.id NOT IN (:...excluded)', { excluded: EXCLUDED_USER_IDS })
        .getCount(),
      this.userRepository
        .createQueryBuilder('u')
        .where('u.id NOT IN (:...excluded)', { excluded: EXCLUDED_USER_IDS })
        .andWhere('u.status = :status', { status: UserStatus.ACTIVE })
        .getCount(),
      this.userRepository
        .createQueryBuilder('u')
        .where('u.id NOT IN (:...excluded)', { excluded: EXCLUDED_USER_IDS })
        .andWhere(this.driverExistenceSql('u.id'))
        .getCount(),
      this.userRepository
        .createQueryBuilder('u')
        .where('u.id NOT IN (:...excluded)', { excluded: EXCLUDED_USER_IDS })
        .andWhere(
          `EXISTS (SELECT 1 FROM bookings b WHERE b.passenger_id = u.id)`,
        )
        .getCount(),
    ]);

    return { totalUsers, activeUsers, drivers, riders };
  }

  private driverExistenceSql(userIdExpr: string): string {
    return `(
      EXISTS (
        SELECT 1 FROM user_verifications uv_i
        INNER JOIN user_verifications uv_v
          ON uv_v.user_id = uv_i.user_id
         AND uv_v.is_current = true
         AND uv_v.verification_type = '${VerificationType.VEHICLE}'
         AND uv_v.status = '${VerificationStatus.VERIFIED}'
        WHERE uv_i.user_id = ${userIdExpr}
          AND uv_i.is_current = true
          AND uv_i.verification_type = '${VerificationType.IDENTITY}'
          AND uv_i.status = '${VerificationStatus.VERIFIED}'
      )
      OR EXISTS (SELECT 1 FROM rides r WHERE r.driver_id = ${userIdExpr})
      OR EXISTS (
        SELECT 1 FROM vehicles v
        WHERE v.user_id = ${userIdExpr} AND v.deleted_at IS NULL
      )
    )`;
  }

  private async isDriverUser(userId: string): Promise<boolean> {
    const row = await this.userRepository
      .createQueryBuilder('u')
      .where('u.id = :userId', { userId })
      .andWhere(this.driverExistenceSql('u.id'))
      .getOne();
    return !!row;
  }

  private async isRiderUser(userId: string): Promise<boolean> {
    const count = await this.bookingRepository.count({
      where: { passengerId: userId },
    });
    return count > 0;
  }

  private async mapUserListItems(
    users: User[],
  ): Promise<AdminUserListItemDto[]> {
    if (users.length === 0) {
      return [];
    }
    const ids = users.map((u) => u.id);

    const [profiles, govRows, corpRows, rideStats, ratingMap] =
      await Promise.all([
        this.profileRepository
          .createQueryBuilder('p')
          .where('p.user_id IN (:...ids)', { ids })
          .getMany(),
        this.verificationRepository
          .createQueryBuilder('uv')
          .where('uv.user_id IN (:...ids)', { ids })
          .andWhere('uv.is_current = true')
          .andWhere('uv.verification_type = :type', {
            type: VerificationType.IDENTITY,
          })
          .getMany(),
        this.corporateRepository
          .createQueryBuilder('c')
          .where('c.user_id IN (:...ids)', { ids })
          .getMany(),
        this.loadRideStatsForUsers(ids),
        this.loadOverallRatings(ids),
      ]);

    const profileById = new Map(profiles.map((p) => [p.userId, p] as const));
    const govById = new Map(govRows.map((v) => [v.userId, v.status] as const));
    const corpById = new Map(
      corpRows.map((c) => [c.userId, c.status] as const),
    );

    const [driverIds, riderIds] = await Promise.all([
      this.userRepository
        .createQueryBuilder('u')
        .select('u.id', 'id')
        .where('u.id IN (:...ids)', { ids })
        .andWhere(this.driverExistenceSql('u.id'))
        .getRawMany<{ id: string }>(),
      this.bookingRepository
        .createQueryBuilder('b')
        .select('DISTINCT b.passenger_id', 'id')
        .where('b.passenger_id IN (:...ids)', { ids })
        .getRawMany<{ id: string }>(),
    ]);
    const isDriver = new Set(driverIds.map((r) => r.id));
    const isRider = new Set(riderIds.map((r) => r.id));

    return users.map((user) => {
      const driver = isDriver.has(user.id);
      const rider = isRider.has(user.id);
      const userType: 'RIDER' | 'DRIVER' | 'BOTH' =
        driver && rider ? 'BOTH' : driver ? 'DRIVER' : 'RIDER';
      const stats = rideStats.get(user.id) ?? {
        passengerCompleted: 0,
        driverCompleted: 0,
      };
      return {
        id: user.id,
        displayName: resolveUserDisplayName(profileById.get(user.id)),
        phoneMasked: maskPhone(user.phone),
        emailMasked: maskEmail(user.email),
        userType,
        governmentIdStatus: govById.get(user.id) ?? null,
        corporateStatus:
          corpById.get(user.id) ?? CorporateIdentityStatus.NOT_VERIFIED,
        totalRides: stats.passengerCompleted + stats.driverCompleted,
        rating: ratingMap.get(user.id) ?? null,
        status: user.status,
        bookingRestricted: user.bookingRestricted,
        ridePublishRestricted: user.ridePublishRestricted,
        createdAt: user.createdAt.toISOString(),
        lastActiveAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      };
    });
  }

  private async loadRideStatsForUsers(
    userIds: string[],
  ): Promise<
    Map<string, { passengerCompleted: number; driverCompleted: number }>
  > {
    const map = new Map<
      string,
      { passengerCompleted: number; driverCompleted: number }
    >();
    for (const id of userIds) {
      map.set(id, { passengerCompleted: 0, driverCompleted: 0 });
    }
    if (userIds.length === 0) {
      return map;
    }

    const passengerRows: Array<{ user_id: string; cnt: string }> =
      await this.bookingRepository.query(
        `
        SELECT passenger_id AS user_id, COUNT(*)::text AS cnt
        FROM bookings
        WHERE passenger_id = ANY($1)
          AND status = $2
        GROUP BY passenger_id
        `,
        [userIds, BookingStatus.COMPLETED],
      );
    for (const row of passengerRows) {
      const current = map.get(row.user_id) ?? {
        passengerCompleted: 0,
        driverCompleted: 0,
      };
      current.passengerCompleted = Number(row.cnt);
      map.set(row.user_id, current);
    }

    const driverRows: Array<{ user_id: string; cnt: string }> =
      await this.rideRepository.query(
        `
        SELECT driver_id AS user_id, COUNT(*)::text AS cnt
        FROM rides
        WHERE driver_id = ANY($1)
          AND status = $2
        GROUP BY driver_id
        `,
        [userIds, RideStatus.COMPLETED],
      );
    for (const row of driverRows) {
      const current = map.get(row.user_id) ?? {
        passengerCompleted: 0,
        driverCompleted: 0,
      };
      current.driverCompleted = Number(row.cnt);
      map.set(row.user_id, current);
    }

    return map;
  }

  private async loadUserRideStats(userId: string) {
    const map = await this.loadRideStatsForUsers([userId]);
    return map.get(userId) ?? { passengerCompleted: 0, driverCompleted: 0 };
  }

  private async loadOverallRatings(
    userIds: string[],
  ): Promise<Map<string, number | null>> {
    const map = new Map<string, number | null>();
    for (const id of userIds) {
      map.set(id, null);
    }
    if (userIds.length === 0) {
      return map;
    }

    const rows: Array<{ user_id: string; avg: string; cnt: string }> =
      await this.dataSource.query(
        `
        SELECT task.to_user_id AS user_id,
               AVG(task.rating)::text AS avg,
               COUNT(task.id)::text AS cnt
        FROM rating_tasks task
        WHERE task.to_user_id = ANY($1)
          AND task.status = 'COMPLETED'
          AND task.rating IS NOT NULL
        GROUP BY task.to_user_id
        `,
        [userIds],
      );
    for (const row of rows) {
      if (Number(row.cnt) > 0) {
        map.set(row.user_id, Number(Number(row.avg).toFixed(2)));
      }
    }
    return map;
  }

  private buildActivityTimeline(
    user: User,
    identity: UserVerification | undefined,
    corporate: CorporateIdentityVerification | null,
  ) {
    const events: Array<{
      type: string;
      at: string;
      summary: string;
    }> = [
      {
        type: 'ACCOUNT_CREATED',
        at: user.createdAt.toISOString(),
        summary: 'Account created',
      },
    ];
    if (user.lastLoginAt) {
      events.push({
        type: 'LAST_LOGIN',
        at: user.lastLoginAt.toISOString(),
        summary: 'Last login',
      });
    }
    if (
      identity?.status === VerificationStatus.VERIFIED &&
      identity.updatedAt
    ) {
      events.push({
        type: 'GOVERNMENT_ID_VERIFIED',
        at: identity.updatedAt.toISOString(),
        summary: 'Government ID verified',
      });
    }
    if (
      corporate?.status === CorporateIdentityStatus.VERIFIED &&
      corporate.verifiedAt
    ) {
      events.push({
        type: 'CORPORATE_VERIFIED',
        at: corporate.verifiedAt.toISOString(),
        summary: 'Corporate identity verified',
      });
    }
    if (user.suspendedAt) {
      events.push({
        type: 'SUSPENDED',
        at: user.suspendedAt.toISOString(),
        summary: 'Account suspended',
      });
    }
    events.sort((a, b) => b.at.localeCompare(a.at));
    return events;
  }

  private assertNotSystemUser(userId: string): void {
    if (EXCLUDED_USER_IDS.includes(userId)) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'ADMIN_SYSTEM_USER_PROTECTED',
        message: 'System users cannot be managed through this API',
        error: 'Bad Request',
      });
    }
  }
}
