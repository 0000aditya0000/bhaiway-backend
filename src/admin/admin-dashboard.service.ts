import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { TrackingService } from '../tracking/tracking.service';
import { UserProfile } from '../users/entities/user-profile.entity';
import { User } from '../users/entities/user.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import {
  UserVerification,
} from '../verification/entities/user-verification.entity';
import {
  VerificationStatus,
  VerificationType,
} from '../verification/enums/verification.enums';
import {
  WalletTransaction,
  WalletTransactionStatus,
} from '../wallet/entities/wallet-transaction.entity';
import { PLATFORM_WALLET_ID } from '../wallet/platform-wallet.constants';
import { AdminAlertService } from './admin-alert.service';
import {
  getAsiaKolkataOperationalDay,
} from './admin-operational-day';
import { PLATFORM_REVENUE_TRANSACTION_TYPES } from './admin.constants';
import { AdminLiveMapFilter } from './dto/admin-dashboard-query.dto';

@Injectable()
export class AdminDashboardService {
  constructor(
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserProfile)
    private readonly userProfileRepository: Repository<UserProfile>,
    @InjectRepository(UserVerification)
    private readonly verificationRepository: Repository<UserVerification>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepository: Repository<Vehicle>,
    @InjectRepository(WalletTransaction)
    private readonly walletTransactionRepository: Repository<WalletTransaction>,
    private readonly trackingService: TrackingService,
    private readonly adminAlertService: AdminAlertService,
  ) {}

  async getSummary() {
    const period = getAsiaKolkataOperationalDay();
    const { start, end } = period;

    const [
      revenueToday,
      totalRidesToday,
      activeRidesNow,
      cancelledRidesToday,
      completedRidesToday,
      users,
      drivers,
      assuredRidesToday,
      attention,
      recentActivity,
    ] = await Promise.all([
      this.sumPlatformRevenue(start, end),
      this.rideRepository
        .createQueryBuilder('ride')
        .where('ride.created_at >= :start AND ride.created_at < :end', {
          start,
          end,
        })
        .getCount(),
      this.rideRepository.count({ where: { status: RideStatus.IN_PROGRESS } }),
      this.rideRepository
        .createQueryBuilder('ride')
        .where('ride.status = :status', { status: RideStatus.CANCELLED })
        .andWhere('ride.cancelled_at >= :start AND ride.cancelled_at < :end', {
          start,
          end,
        })
        .getCount(),
      this.rideRepository
        .createQueryBuilder('ride')
        .where('ride.status = :status', { status: RideStatus.COMPLETED })
        .andWhere(
          '(ride.completed_at >= :start AND ride.completed_at < :end)',
          { start, end },
        )
        .getCount(),
      this.countUsers(),
      this.countEligibleDrivers(),
      this.rideRepository
        .createQueryBuilder('ride')
        .where('ride.ride_type = :type', { type: RideType.ASSURED })
        .andWhere('ride.created_at >= :start AND ride.created_at < :end', {
          start,
          end,
        })
        .getCount(),
      this.adminAlertService.getAttentionSummary(8),
      this.adminAlertService.getRecentActivity({ limit: 10 }),
    ]);

    return {
      period: {
        timezone: period.timezone,
        start: period.startIso,
        end: period.endIso,
      },
      metrics: {
        revenueToday,
        totalRidesToday,
        activeRidesNow,
        cancelledRidesToday,
        completedRidesToday,
        users,
        drivers,
        assuredRidesToday,
      },
      attention: {
        critical: attention.critical,
        warning: attention.warning,
        total: attention.total,
        alerts: attention.alerts.map((alert) => ({
          id: alert.id,
          category: alert.category,
          severity: alert.severity,
          status: alert.status,
          title: alert.title,
          message: alert.message,
          source: alert.source,
          createdAt: alert.createdAt.toISOString(),
        })),
      },
      recentActivity: recentActivity.items.map((item) => ({
        id: item.id,
        eventType: item.eventType,
        category: item.category,
        severity: item.severity,
        title: item.title,
        description: item.description,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  }

  async getLiveMap(filter: AdminLiveMapFilter = AdminLiveMapFilter.ACTIVE) {
    if (filter === AdminLiveMapFilter.SOS) {
      return { filter, trackingAvailable: true, items: [] };
    }

    const qb = this.rideRepository
      .createQueryBuilder('ride')
      .where('ride.status = :status', { status: RideStatus.IN_PROGRESS });

    if (filter === AdminLiveMapFilter.OFFICE_COMMUTE) {
      qb.andWhere('ride.ride_type = :type', { type: RideType.COMMUTE });
    } else if (filter === AdminLiveMapFilter.OUTSTATION) {
      // No OUTSTATION enum exists. Product maps non-commute rides (REGULAR + ASSURED) here.
      qb.andWhere('ride.ride_type IN (:...types)', {
        types: [RideType.REGULAR, RideType.ASSURED],
      });
    }

    const rides = await qb
      .orderBy('ride.updated_at', 'DESC')
      .take(500)
      .getMany();

    if (rides.length === 0) {
      return { filter, trackingAvailable: true, items: [] };
    }

    const rideIds = rides.map((r) => r.id);
    const driverIds = [...new Set(rides.map((r) => r.driverId))];
    const vehicleIds = [...new Set(rides.map((r) => r.vehicleId))];

    const [locationResult, profiles, vehicles] = await Promise.all([
      this.trackingService.getStoredLocationsForRides(rideIds),
      this.userProfileRepository.find({
        where: { userId: In(driverIds) },
      }),
      this.vehicleRepository.find({
        where: { id: In(vehicleIds) },
      }),
    ]);

    const locations = locationResult.locations;
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
    const vehicleById = new Map(vehicles.map((v) => [v.id, v]));

    const items = rides.map((ride) => {
      const location = locations.get(ride.id) ?? null;
      const profile = profileByUser.get(ride.driverId);
      const vehicle = vehicleById.get(ride.vehicleId);
      const displayName =
        profile?.displayName?.trim() ||
        [profile?.firstName, profile?.lastName]
          .filter(Boolean)
          .join(' ')
          .trim() ||
        null;

      const hasLiveLocation = location != null;
      const locationStatus = !locationResult.redisReady
        ? 'TRACKING_UNAVAILABLE'
        : hasLiveLocation
          ? 'AVAILABLE'
          : 'MISSING';

      return {
        rideId: ride.id,
        rideType: ride.rideType,
        rideStatus: ride.status,
        driverId: ride.driverId,
        driverDisplayName: displayName,
        vehicleMake: vehicle?.make ?? null,
        vehicleModel: vehicle?.model ?? null,
        vehicleRegistrationMasked: vehicle
          ? this.maskRegistration(vehicle.registrationNumber)
          : null,
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        locationUpdatedAt: location?.updatedAt ?? null,
        heading: location?.heading ?? null,
        speed: location?.speed ?? null,
        hasLiveLocation,
        locationStatus,
        sosActive: false,
      };
    });

    return {
      filter,
      trackingAvailable: locationResult.redisReady,
      items,
    };
  }

  async getRecentActivity(limit = 20, cursor?: string) {
    const page = await this.adminAlertService.getRecentActivity({
      limit,
      cursor,
    });
    return {
      items: page.items.map((item) => ({
        id: item.id,
        eventType: item.eventType,
        category: item.category,
        severity: item.severity,
        title: item.title,
        description: item.description,
        createdAt: item.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  private async sumPlatformRevenue(start: Date, end: Date): Promise<number> {
    const row = await this.walletTransactionRepository
      .createQueryBuilder('tx')
      .select('COALESCE(SUM(tx.amount), 0)', 'total')
      .where('tx.wallet_id = :walletId', { walletId: PLATFORM_WALLET_ID })
      .andWhere('tx.status = :status', {
        status: WalletTransactionStatus.POSTED,
      })
      .andWhere('tx.transaction_type IN (:...types)', {
        types: [...PLATFORM_REVENUE_TRANSACTION_TYPES],
      })
      .andWhere('tx.created_at >= :start AND tx.created_at < :end', {
        start,
        end,
      })
      .getRawOne<{ total: string }>();

    return Number(row?.total ?? 0);
  }

  private async countUsers(): Promise<number> {
    return this.userRepository
      .createQueryBuilder('user')
      .where('user.id != :platformId', {
        platformId: '00000000-0000-4000-8000-000000000001',
      })
      .getCount();
  }

  /**
   * Driver = user currently eligible to publish rides:
   * current IDENTITY + VEHICLE verifications are VERIFIED.
   * Matches VerificationService.canPublishRide (without a specific vehicleId).
   */
  private async countEligibleDrivers(): Promise<number> {
    const rows = await this.verificationRepository.query(
      `
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT uv.user_id
        FROM user_verifications uv
        WHERE uv.is_current = true
          AND uv.status = $1
          AND uv.verification_type IN ($2, $3)
          AND uv.user_id != $4
        GROUP BY uv.user_id
        HAVING COUNT(DISTINCT uv.verification_type) = 2
      ) eligible
      `,
      [
        VerificationStatus.VERIFIED,
        VerificationType.IDENTITY,
        VerificationType.VEHICLE,
        '00000000-0000-4000-8000-000000000001',
      ],
    );
    return Number(rows?.[0]?.count ?? 0);
  }

  private maskRegistration(value: string): string {
    const trimmed = value.trim().toUpperCase();
    if (trimmed.length <= 4) {
      return trimmed;
    }
    return `${'*'.repeat(Math.min(trimmed.length - 4, 6))}${trimmed.slice(-4)}`;
  }
}
