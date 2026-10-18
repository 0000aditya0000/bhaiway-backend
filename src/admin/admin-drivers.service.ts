import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CorporateIdentityVerification } from '../corporate-identity/entities/corporate-identity-verification.entity';
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
import { PLATFORM_USER_ID } from '../wallet/platform-wallet.constants';
import { ADMIN_BOOTSTRAP_USER_ID } from './admin.constants';
import { maskPhone, maskRegistration } from './admin-privacy.util';
import { mapAdminVerificationBundle } from './admin-verification.mapper';
import {
  AdminDriverListItemDto,
  AdminDriverListQueryDto,
  AdminDriverPageDto,
  AdminDriverSortField,
  AdminDriverStatusFilter,
} from './dto/admin-driver.dto';

const EXCLUDED_USER_IDS = [PLATFORM_USER_ID, ADMIN_BOOTSTRAP_USER_ID];

@Injectable()
export class AdminDriversService {
  constructor(
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
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepository: Repository<Vehicle>,
  ) {}

  /**
   * Drivers directory: users with a non-deleted vehicle and/or publish-eligible
   * IDENTITY+VEHICLE verification and/or at least one ride as driver.
   */
  async list(query: AdminDriverListQueryDto): Promise<AdminDriverPageDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sortBy = query.sortBy ?? AdminDriverSortField.CREATED_AT;
    const sortOrder = query.sortOrder ?? 'DESC';

    const qb = this.userRepository
      .createQueryBuilder('u')
      .leftJoin(UserProfile, 'p', 'p.user_id = u.id')
      .where('u.id NOT IN (:...excluded)', { excluded: EXCLUDED_USER_IDS })
      .andWhere(this.driverExistenceSql('u.id'));

    if (query.status === AdminDriverStatusFilter.ACTIVE) {
      qb.andWhere('u.status = :active', { active: UserStatus.ACTIVE });
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM vehicles v
          WHERE v.user_id = u.id AND v.deleted_at IS NULL AND v.is_active = true
        )`,
      );
    } else if (query.status === AdminDriverStatusFilter.SUSPENDED) {
      qb.andWhere('u.status = :suspended', {
        suspended: UserStatus.SUSPENDED,
      });
    } else if (query.status === AdminDriverStatusFilter.INACTIVE) {
      qb.andWhere(
        `(u.status = :deactivated OR NOT EXISTS (
          SELECT 1 FROM vehicles v
          WHERE v.user_id = u.id AND v.deleted_at IS NULL AND v.is_active = true
        ))`,
        { deactivated: UserStatus.DEACTIVATED },
      );
    }

    if (query.search?.trim()) {
      const term = `%${query.search.trim().toLowerCase()}%`;
      qb.andWhere(
        `(CAST(u.id AS text) ILIKE :term
          OR LOWER(u.phone) LIKE :term
          OR LOWER(COALESCE(p.display_name, '')) LIKE :term
          OR LOWER(COALESCE(p.first_name, '')) LIKE :term
          OR LOWER(COALESCE(p.last_name, '')) LIKE :term
          OR EXISTS (
            SELECT 1 FROM vehicles v
            WHERE v.user_id = u.id
              AND v.deleted_at IS NULL
              AND LOWER(v.registration_number) LIKE :term
          ))`,
        { term },
      );
    }

    this.applyVerificationFilter(
      qb,
      query.governmentIdStatus,
      VerificationType.IDENTITY,
      'govStatus',
    );
    this.applyVerificationFilter(
      qb,
      query.drivingLicenceStatus,
      VerificationType.DRIVING_LICENSE,
      'dlStatus',
    );
    this.applyVerificationFilter(
      qb,
      query.vehicleRcStatus,
      VerificationType.VEHICLE,
      'rcStatus',
    );

    const sortColumn =
      sortBy === AdminDriverSortField.LAST_LOGIN_AT
        ? 'u.last_login_at'
        : 'u.created_at';
    qb.orderBy(sortColumn, sortOrder).addOrderBy('u.id', 'DESC');

    const total = await qb.getCount();
    const users = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return {
      items: await this.mapDriverListItems(users),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async getDetail(driverId: string) {
    if (EXCLUDED_USER_IDS.includes(driverId)) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ADMIN_DRIVER_NOT_FOUND',
        message: 'Driver not found',
        error: 'Not Found',
      });
    }

    const user = await this.userRepository
      .createQueryBuilder('u')
      .where('u.id = :driverId', { driverId })
      .andWhere(this.driverExistenceSql('u.id'))
      .getOne();
    if (!user) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ADMIN_DRIVER_NOT_FOUND',
        message: 'Driver not found',
        error: 'Not Found',
      });
    }

    const [
      profile,
      verifications,
      corporate,
      vehicles,
      ratings,
      ops,
      earnings,
    ] = await Promise.all([
      this.profileRepository.findOne({ where: { userId: driverId } }),
      this.verificationRepository.find({
        where: { userId: driverId, isCurrent: true },
      }),
      this.corporateRepository.findOne({ where: { userId: driverId } }),
      this.vehicleRepository.find({
        where: { userId: driverId },
        order: { createdAt: 'DESC' },
      }),
      this.ratingsService.getUserRatingRoleAverages(driverId),
      this.loadDriverOps(driverId),
      this.driverEarningsService.getLifetimeEarningsByRideType(driverId),
    ]);

    return {
      driverId: user.id,
      userId: user.id,
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
      accountStatus: user.status,
      operationalStatus: this.operationalStatus(user, vehicles),
      ridePublishRestricted: user.ridePublishRestricted,
      ridePublishRestrictedReason: user.ridePublishRestrictedReason,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      lastActiveAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      rating:
        ratings.asDriver.totalRatings > 0
          ? ratings.asDriver.averageRating
          : null,
      ratings,
      verification: {
        ...mapAdminVerificationBundle(verifications, corporate),
        insurance: {
          status: null,
          note: 'Vehicle insurance status is not stored in the current schema.',
        },
      },
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
        fuelType: null as string | null,
        fuelTypeNote: 'Fuel type is not stored on the vehicle entity.',
      })),
      operations: {
        semantics:
          'Counts are rides where driver_id = this user. Includes REGULAR, ASSURED, and COMMUTE. Each ride counted once.',
        totalRides: ops.total,
        completedRides: ops.completed,
        cancelledRides: ops.cancelled,
        cancellationRatePercent: ops.cancellationRatePercent,
      },
      earnings,
      activity: [
        {
          type: 'ACCOUNT_CREATED',
          at: user.createdAt.toISOString(),
          summary: 'Account created',
        },
        ...(user.lastLoginAt
          ? [
              {
                type: 'LAST_LOGIN',
                at: user.lastLoginAt.toISOString(),
                summary: 'Last login',
              },
            ]
          : []),
      ],
    };
  }

  private applyVerificationFilter(
    qb: ReturnType<Repository<User>['createQueryBuilder']>,
    status: VerificationStatus | undefined,
    type: VerificationType,
    param: string,
  ): void {
    if (!status) {
      return;
    }
    qb.andWhere(
      `EXISTS (
        SELECT 1 FROM user_verifications uv
        WHERE uv.user_id = u.id
          AND uv.is_current = true
          AND uv.verification_type = :${param}Type
          AND uv.status = :${param}
      )`,
      {
        [`${param}Type`]: type,
        [param]: status,
      },
    );
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

  private async mapDriverListItems(
    users: User[],
  ): Promise<AdminDriverListItemDto[]> {
    if (users.length === 0) {
      return [];
    }
    const ids = users.map((u) => u.id);

    const [profiles, verifications, vehicles, opsMap, ratingMap] =
      await Promise.all([
        this.profileRepository
          .createQueryBuilder('p')
          .where('p.user_id IN (:...ids)', { ids })
          .getMany(),
        this.verificationRepository
          .createQueryBuilder('uv')
          .where('uv.user_id IN (:...ids)', { ids })
          .andWhere('uv.is_current = true')
          .getMany(),
        this.vehicleRepository
          .createQueryBuilder('v')
          .where('v.user_id IN (:...ids)', { ids })
          .andWhere('v.deleted_at IS NULL')
          .orderBy('v.is_active', 'DESC')
          .addOrderBy('v.created_at', 'DESC')
          .getMany(),
        this.loadDriverOpsBatch(ids),
        this.loadDriverRatings(ids),
      ]);

    const profileById = new Map(profiles.map((p) => [p.userId, p] as const));
    const verByUser = new Map<
      string,
      Map<VerificationType, VerificationStatus>
    >();
    for (const v of verifications) {
      const map =
        verByUser.get(v.userId) ??
        new Map<VerificationType, VerificationStatus>();
      map.set(v.verificationType, v.status);
      verByUser.set(v.userId, map);
    }
    const primaryVehicle = new Map<string, Vehicle>();
    for (const v of vehicles) {
      if (!primaryVehicle.has(v.userId)) {
        primaryVehicle.set(v.userId, v);
      }
    }

    return users.map((user) => {
      const vers =
        verByUser.get(user.id) ??
        new Map<VerificationType, VerificationStatus>();
      const vehicle = primaryVehicle.get(user.id);
      const ops = opsMap.get(user.id) ?? {
        total: 0,
        completed: 0,
        cancelled: 0,
        cancellationRatePercent: null as number | null,
      };
      const allVehicles = vehicles.filter((v) => v.userId === user.id);
      const governmentIdStatus = vers.get(VerificationType.IDENTITY) ?? null;
      const drivingLicenceStatus =
        vers.get(VerificationType.DRIVING_LICENSE) ?? null;
      const vehicleRcStatus = vers.get(VerificationType.VEHICLE) ?? null;

      return {
        driverId: user.id,
        userId: user.id,
        displayName: resolveUserDisplayName(profileById.get(user.id)),
        phoneMasked: maskPhone(user.phone),
        governmentIdStatus,
        drivingLicenceStatus,
        vehicleRcStatus,
        rating: ratingMap.get(user.id) ?? null,
        totalRides: ops.total,
        cancellationRatePercent: ops.cancellationRatePercent,
        accountStatus: user.status,
        operationalStatus: this.operationalStatus(user, allVehicles),
        vehicleRegistrationMasked: vehicle
          ? maskRegistration(vehicle.registrationNumber)
          : null,
        vehicleMake: vehicle?.make ?? null,
        vehicleModel: vehicle?.model ?? null,
        ridePublishRestricted: user.ridePublishRestricted,
        createdAt: user.createdAt.toISOString(),
      };
    });
  }

  private operationalStatus(
    user: User,
    vehicles: Vehicle[],
  ): 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' {
    if (user.status === UserStatus.SUSPENDED) {
      return 'SUSPENDED';
    }
    const hasActive = vehicles.some((v) => v.isActive && !v.deletedAt);
    if (user.status === UserStatus.ACTIVE && hasActive) {
      return 'ACTIVE';
    }
    return 'INACTIVE';
  }

  private async loadDriverOps(driverId: string) {
    const map = await this.loadDriverOpsBatch([driverId]);
    return (
      map.get(driverId) ?? {
        total: 0,
        completed: 0,
        cancelled: 0,
        cancellationRatePercent: null as number | null,
      }
    );
  }

  private async loadDriverOpsBatch(driverIds: string[]) {
    const map = new Map<
      string,
      {
        total: number;
        completed: number;
        cancelled: number;
        cancellationRatePercent: number | null;
      }
    >();
    for (const id of driverIds) {
      map.set(id, {
        total: 0,
        completed: 0,
        cancelled: 0,
        cancellationRatePercent: null,
      });
    }
    if (driverIds.length === 0) {
      return map;
    }

    const rows: Array<{
      driver_id: string;
      total: string;
      completed: string;
      cancelled: string;
    }> = await this.rideRepository.query(
      `
      SELECT driver_id,
             COUNT(*)::text AS total,
             COUNT(*) FILTER (WHERE status = $2)::text AS completed,
             COUNT(*) FILTER (WHERE status = $3)::text AS cancelled
      FROM rides
      WHERE driver_id = ANY($1)
      GROUP BY driver_id
      `,
      [driverIds, RideStatus.COMPLETED, RideStatus.CANCELLED],
    );

    for (const row of rows) {
      const completed = Number(row.completed);
      const cancelled = Number(row.cancelled);
      const denom = completed + cancelled;
      map.set(row.driver_id, {
        total: Number(row.total),
        completed,
        cancelled,
        cancellationRatePercent:
          denom === 0 ? null : Number(((cancelled / denom) * 100).toFixed(2)),
      });
    }
    return map;
  }

  private async loadDriverRatings(
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
      await this.rideRepository.manager.query(
        `
        SELECT task.to_user_id AS user_id,
               AVG(task.rating)::text AS avg,
               COUNT(task.id)::text AS cnt
        FROM rating_tasks task
        INNER JOIN rides ride ON ride.id = task.ride_id
        WHERE task.to_user_id = ANY($1)
          AND ride.driver_id = task.to_user_id
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
}
