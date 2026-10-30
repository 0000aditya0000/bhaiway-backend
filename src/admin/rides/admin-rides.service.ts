import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Booking } from '../../bookings/entities/booking.entity';
import {
  BookingPaymentStatus,
  BookingStatus,
} from '../../bookings/enums/booking.enums';
import { CorporateIdentityVerification } from '../../corporate-identity/entities/corporate-identity-verification.entity';
import { GstInvoice } from '../../invoices/entities/invoice.entity';
import { RatingsService } from '../../ratings/ratings.service';
import { Ride } from '../../rides/entities/ride.entity';
import { RideStatus, RideType } from '../../rides/enums/ride.enums';
import { TrackingService } from '../../tracking/tracking.service';
import { RIDE_TRACKING_STALE_AFTER_MS } from '../../tracking/tracking.constants';
import { UserProfile } from '../../users/entities/user-profile.entity';
import { User } from '../../users/entities/user.entity';
import { resolveUserDisplayName } from '../../users/user-display-name.util';
import { Vehicle } from '../../vehicles/entities/vehicle.entity';
import { UserVerification } from '../../verification/entities/user-verification.entity';
import { VerificationType } from '../../verification/enums/verification.enums';
import { WalletHold } from '../../wallet/entities/wallet-hold.entity';
import {
  WalletTransaction,
  WalletTransactionType,
} from '../../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../../wallet/entities/wallet.entity';
import { maskPhone } from '../admin-privacy.util';
import { mapAdminVerificationBundle } from '../admin-verification.mapper';
import { AdminRideCancellation } from '../entities/admin-ride-cancellation.entity';
import { AssuredLifecycleEvent } from '../../assured/entities/assured-lifecycle-event.entity';
import {
  AdminRideListItemDto,
  AdminRideListQueryDto,
  AdminRideListResponseDto,
} from './dto/admin-ride-list.dto';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AdminRidesService {
  constructor(
    private readonly trackingService: TrackingService,
    private readonly ratingsService: RatingsService,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserProfile)
    private readonly profileRepository: Repository<UserProfile>,
    @InjectRepository(UserVerification)
    private readonly verificationRepository: Repository<UserVerification>,
    @InjectRepository(CorporateIdentityVerification)
    private readonly corporateRepository: Repository<CorporateIdentityVerification>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepository: Repository<Vehicle>,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @InjectRepository(WalletHold)
    private readonly holdRepository: Repository<WalletHold>,
    @InjectRepository(WalletTransaction)
    private readonly walletTxRepository: Repository<WalletTransaction>,
    @InjectRepository(GstInvoice)
    private readonly invoiceRepository: Repository<GstInvoice>,
    @InjectRepository(AdminRideCancellation)
    private readonly adminCancelRepository: Repository<AdminRideCancellation>,
    @InjectRepository(AssuredLifecycleEvent)
    private readonly assuredEventRepository: Repository<AssuredLifecycleEvent>,
  ) {}

  async list(query: AdminRideListQueryDto): Promise<AdminRideListResponseDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const qb = this.rideRepository
      .createQueryBuilder('ride')
      .innerJoin(User, 'driver', 'driver.id = ride.driver_id')
      .leftJoin(UserProfile, 'profile', 'profile.user_id = driver.id');

    if (query.status) {
      qb.andWhere('ride.status = :status', { status: query.status });
    }
    if (query.rideType) {
      qb.andWhere('ride.ride_type = :rideType', { rideType: query.rideType });
    }
    if (query.driverId) {
      qb.andWhere('ride.driver_id = :driverId', { driverId: query.driverId });
    }
    if (query.passengerId) {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM bookings pb
          WHERE pb.ride_id = ride.id AND pb.passenger_id = :passengerId
        )`,
        { passengerId: query.passengerId },
      );
    }
    if (query.source) {
      qb.andWhere('ride.source ILIKE :source', {
        source: `%${query.source}%`,
      });
    }
    if (query.destination) {
      qb.andWhere('ride.destination ILIKE :destination', {
        destination: `%${query.destination}%`,
      });
    }
    if (query.departureFrom) {
      qb.andWhere('ride.departure_date >= :departureFrom', {
        departureFrom: query.departureFrom,
      });
    }
    if (query.departureTo) {
      qb.andWhere('ride.departure_date <= :departureTo', {
        departureTo: query.departureTo,
      });
    }
    if (query.createdFrom) {
      qb.andWhere('ride.created_at >= :createdFrom', {
        createdFrom: new Date(query.createdFrom),
      });
    }
    if (query.createdTo) {
      qb.andWhere('ride.created_at <= :createdTo', {
        createdTo: new Date(query.createdTo),
      });
    }

    const search = query.search?.trim();
    if (search) {
      if (UUID_RE.test(search)) {
        qb.andWhere(
          `(ride.id = :searchId OR ride.driver_id = :searchId OR EXISTS (
              SELECT 1 FROM bookings sb
              WHERE sb.ride_id = ride.id AND sb.passenger_id = :searchId
            ))`,
          { searchId: search.toLowerCase() },
        );
      } else {
        const like = `%${search}%`;
        qb.andWhere(
          `(
            driver.phone ILIKE :like
            OR COALESCE(profile.display_name, '') ILIKE :like
            OR COALESCE(profile.first_name, '') ILIKE :like
            OR COALESCE(profile.last_name, '') ILIKE :like
            OR EXISTS (
              SELECT 1
              FROM bookings pb
              INNER JOIN users pu ON pu.id = pb.passenger_id
              LEFT JOIN user_profiles pp ON pp.user_id = pu.id
              WHERE pb.ride_id = ride.id
                AND (
                  pu.phone ILIKE :like
                  OR COALESCE(pp.display_name, '') ILIKE :like
                  OR COALESCE(pp.first_name, '') ILIKE :like
                  OR COALESCE(pp.last_name, '') ILIKE :like
                )
            )
          )`,
          { like },
        );
      }
    }

    const total = await qb.clone().getCount();
    const rides = await qb
      .orderBy('ride.created_at', 'DESC')
      .addOrderBy('ride.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    const items = await this.mapListItems(rides);
    return { items, page, limit, total };
  }

  async getDetail(rideId: string) {
    const ride = await this.rideRepository.findOne({ where: { id: rideId } });
    if (!ride) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ADMIN_RIDE_NOT_FOUND',
        message: 'Ride not found',
        error: 'NotFound',
      });
    }

    const bookings = await this.bookingRepository.find({
      where: { rideId: ride.id },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    const userIds = [
      ride.driverId,
      ...bookings.map((booking) => booking.passengerId),
    ];
    const uniqueUserIds = [...new Set(userIds)];

    const [
      driver,
      driverProfile,
      vehicle,
      verifications,
      corporate,
      rating,
      users,
      profiles,
      locationBundle,
      invoices,
      adminCancels,
      assuredEvents,
    ] = await Promise.all([
      this.userRepository.findOne({ where: { id: ride.driverId } }),
      this.profileRepository.findOne({ where: { userId: ride.driverId } }),
      this.vehicleRepository.findOne({ where: { id: ride.vehicleId } }),
      this.verificationRepository.find({
        where: { userId: ride.driverId, isCurrent: true },
      }),
      this.corporateRepository.findOne({ where: { userId: ride.driverId } }),
      this.ratingsService.getUserRatingRoleAverages(ride.driverId),
      this.userRepository.find({ where: { id: In(uniqueUserIds) } }),
      this.profileRepository.find({ where: { userId: In(uniqueUserIds) } }),
      this.trackingService.getStoredLocationsForRides([ride.id]),
      this.invoiceRepository.find({ where: { rideId: ride.id } }),
      this.adminCancelRepository.find({
        where: { rideId: ride.id },
        order: { createdAt: 'DESC' },
      }),
      this.assuredEventRepository.find({
        where: { rideId: ride.id },
        order: { createdAt: 'ASC' },
      }),
    ]);

    const userById = new Map(users.map((row) => [row.id, row]));
    const profileById = new Map(profiles.map((row) => [row.userId, row]));
    const bookedSeats = this.bookedSeatsForRide(ride.rideType, bookings);

    const holdIds = [
      ride.driverDepositHoldId,
      ...bookings.map((booking) => booking.walletHoldId),
    ].filter((id): id is string => Boolean(id));
    const txRefIds = [
      ride.id,
      ...bookings.map((booking) => booking.id),
      ...holdIds,
      ...bookings
        .map((booking) => booking.walletTransactionId)
        .filter((id): id is string => Boolean(id)),
      ...bookings
        .map((booking) => booking.fareWalletTransactionId)
        .filter((id): id is string => Boolean(id)),
    ];

    const [holds, walletTx] = await Promise.all([
      holdIds.length > 0
        ? this.holdRepository.find({ where: { id: In(holdIds) } })
        : Promise.resolve([] as WalletHold[]),
      txRefIds.length > 0
        ? this.walletTxRepository
            .createQueryBuilder('tx')
            .where('tx.reference_id IN (:...ids)', { ids: txRefIds })
            .orWhere('tx.id IN (:...ids)', { ids: txRefIds })
            .orderBy('tx.created_at', 'ASC')
            .getMany()
        : Promise.resolve([] as WalletTransaction[]),
    ]);

    return {
      ride: this.mapRide(ride, bookedSeats),
      driver: {
        id: ride.driverId,
        displayName: resolveUserDisplayName(driverProfile),
        firstName: driverProfile?.firstName ?? null,
        lastName: driverProfile?.lastName ?? null,
        phone: driver?.phone ?? null,
        email: driver?.email ?? null,
        profilePhoto: driverProfile?.profilePhoto ?? null,
        accountStatus: driver?.status ?? null,
        verification: mapAdminVerificationBundle(verifications, corporate),
        identityStatus:
          verifications.find(
            (row) => row.verificationType === VerificationType.IDENTITY,
          )?.status ?? null,
        drivingLicenceStatus:
          verifications.find(
            (row) => row.verificationType === VerificationType.DRIVING_LICENSE,
          )?.status ?? null,
        vehicleVerificationStatus:
          verifications.find(
            (row) => row.verificationType === VerificationType.VEHICLE,
          )?.status ?? null,
        vehicle: vehicle
          ? {
              id: vehicle.id,
              registrationNumber: vehicle.registrationNumber,
              make: vehicle.make,
              model: vehicle.model,
              variant: vehicle.variant,
              color: vehicle.color,
              vehicleType: vehicle.vehicleType,
              seatingCapacity: vehicle.seatingCapacity,
              isActive: vehicle.isActive,
            }
          : null,
        ratings: rating,
      },
      passengers: bookings.map((booking) => {
        const passenger = userById.get(booking.passengerId);
        const profile = profileById.get(booking.passengerId);
        return {
          userId: booking.passengerId,
          displayName: resolveUserDisplayName(profile),
          phone: passenger?.phone ?? null,
          email: passenger?.email ?? null,
          profilePhoto: profile?.profilePhoto ?? null,
          bookingId: booking.id,
          seats: booking.seats,
          bookingStatus: booking.status,
          bookingMode: booking.bookingMode,
          paymentMethod: booking.paymentMethod,
          farePaymentMethod: booking.farePaymentMethod,
          paymentStatus: booking.paymentStatus,
          collectedAmount: this.collectedAmount(booking),
          pricePerSeatSnapshot: booking.pricePerSeatSnapshot,
          totalAmount: booking.totalAmount,
          couponDiscountAmount: booking.couponDiscountAmount,
          couponRedemptionId: booking.couponRedemptionId,
          depositCouponId: booking.depositCouponId,
          pickupStatus: booking.pickupStatus,
          pickupVerifiedAt: booking.pickupVerifiedAt?.toISOString() ?? null,
          createdAt: booking.createdAt.toISOString(),
          cancelledAt: booking.cancelledAt?.toISOString() ?? null,
          cancellationReason: booking.cancellationReason,
          pickupDropCoordinates: null,
        };
      }),
      financials: {
        fare: {
          pricePerSeat: ride.pricePerSeat,
          bookedSeats,
          commuteDriverShareTotal: this.sumNullable(
            bookings.map((booking) => booking.driverShareAmount),
          ),
          commutePlatformShareTotal: this.sumNullable(
            bookings.map((booking) => booking.platformShareAmount),
          ),
          discountTotal: this.sumNullable(
            bookings.map((booking) => booking.couponDiscountAmount),
          ),
        },
        payments: bookings.map((booking) => ({
          bookingId: booking.id,
          paymentMethod: booking.paymentMethod,
          farePaymentMethod: booking.farePaymentMethod,
          paymentStatus: booking.paymentStatus,
          totalAmount: booking.totalAmount,
          collectedAmount: this.collectedAmount(booking),
          walletTransactionId: booking.walletTransactionId,
          fareWalletTransactionId: booking.fareWalletTransactionId,
        })),
        walletTransactions: walletTx.map((tx) => this.mapWalletTx(tx)),
        refunds: walletTx
          .filter((tx) => tx.transactionType === WalletTransactionType.REFUND)
          .map((tx) => this.mapWalletTx(tx)),
        deposits: holds.map((hold) => ({
          id: hold.id,
          walletId: hold.walletId,
          amount: hold.amount,
          status: hold.status,
          holdType: hold.holdType,
          referenceType: hold.referenceType,
          referenceId: hold.referenceId,
        })),
        earnings: walletTx
          .filter(
            (tx) => tx.transactionType === WalletTransactionType.DRIVER_EARNING,
          )
          .map((tx) => this.mapWalletTx(tx)),
        invoices: invoices.map((invoice) => ({
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          bookingId: invoice.bookingId,
          invoiceTotalPaise: invoice.invoiceTotalPaise,
          currency: invoice.currency,
          issuedAt: invoice.issuedAt?.toISOString?.() ?? invoice.issuedAt,
        })),
      },
      location: this.mapLocation(ride, locationBundle),
      history: {
        createdAt: ride.createdAt.toISOString(),
        currentStatus: ride.status,
        cancelledAt: ride.cancelledAt?.toISOString() ?? null,
        cancellationReason: ride.cancellationReason,
        cancelledByUserId: ride.cancelledByUserId,
        completedAt: ride.completedAt?.toISOString() ?? null,
        assuredLifecycleEvents: assuredEvents.map((event) => ({
          id: event.id,
          eventType: event.eventType,
          createdAt: event.createdAt.toISOString(),
        })),
        adminCancellations: adminCancels.map((row) => ({
          id: row.id,
          adminUserId: row.adminUserId,
          previousStatus: row.previousStatus,
          finalStatus: row.finalStatus,
          reason: row.reason,
          seriesScope: row.seriesScope,
          supportEscalationRequired: row.supportEscalationRequired,
          refundTotal: row.refundTotal,
          depositReleaseTotal: row.depositReleaseTotal,
          compensationTotal: row.compensationTotal,
          alreadyApplied: row.alreadyApplied,
          bookings: row.bookings,
          createdAt: row.createdAt.toISOString(),
        })),
      },
    };
  }

  bookedSeatsForRide(rideType: RideType, bookings: Booking[]): number {
    return bookings.reduce((sum, booking) => {
      if (booking.status === BookingStatus.CONFIRMED) {
        return sum + booking.seats;
      }
      if (
        rideType !== RideType.COMMUTE &&
        booking.status === BookingStatus.PENDING
      ) {
        return sum + booking.seats;
      }
      return sum;
    }, 0);
  }

  private async mapListItems(rides: Ride[]): Promise<AdminRideListItemDto[]> {
    if (rides.length === 0) {
      return [];
    }
    const driverIds = [...new Set(rides.map((ride) => ride.driverId))];
    const rideIds = rides.map((ride) => ride.id);
    const [drivers, profiles, bookings] = await Promise.all([
      this.userRepository.find({ where: { id: In(driverIds) } }),
      this.profileRepository.find({ where: { userId: In(driverIds) } }),
      this.bookingRepository.find({
        where: { rideId: In(rideIds) },
        select: {
          id: true,
          rideId: true,
          seats: true,
          status: true,
          bookingMode: true,
        },
      }),
    ]);
    const driverById = new Map(drivers.map((row) => [row.id, row]));
    const profileById = new Map(profiles.map((row) => [row.userId, row]));
    const bookingsByRide = new Map<string, Booking[]>();
    for (const booking of bookings) {
      const list = bookingsByRide.get(booking.rideId) ?? [];
      list.push(booking);
      bookingsByRide.set(booking.rideId, list);
    }

    return rides.map((ride) => {
      const driver = driverById.get(ride.driverId);
      const profile = profileById.get(ride.driverId);
      return {
        id: ride.id,
        rideType: ride.rideType,
        status: ride.status,
        source: ride.source,
        destination: ride.destination,
        departureDate: String(ride.departureDate),
        departureTime: String(ride.departureTime).slice(0, 8),
        totalSeats: ride.totalSeats,
        availableSeats: ride.availableSeats,
        bookedSeats: this.bookedSeatsForRide(
          ride.rideType,
          bookingsByRide.get(ride.id) ?? [],
        ),
        pricePerSeat: ride.pricePerSeat,
        createdAt: ride.createdAt.toISOString(),
        cancelledAt: ride.cancelledAt?.toISOString() ?? null,
        completedAt: ride.completedAt?.toISOString() ?? null,
        driver: {
          id: ride.driverId,
          displayName: resolveUserDisplayName(profile),
          phoneMasked: maskPhone(driver?.phone),
          profilePhoto: profile?.profilePhoto ?? null,
        },
      };
    });
  }

  private mapRide(ride: Ride, bookedSeats: number) {
    return {
      id: ride.id,
      rideType: ride.rideType,
      status: ride.status,
      source: ride.source,
      destination: ride.destination,
      sourceLatitude: ride.sourceLatitude,
      sourceLongitude: ride.sourceLongitude,
      destinationLatitude: ride.destinationLatitude,
      destinationLongitude: ride.destinationLongitude,
      routePolyline: ride.routePolyline,
      routeLengthMeters: ride.routeLengthMeters,
      routeDurationSeconds: ride.routeDurationSeconds,
      departureDate: String(ride.departureDate),
      departureTime: String(ride.departureTime).slice(0, 8),
      totalSeats: ride.totalSeats,
      availableSeats: ride.availableSeats,
      bookedSeats,
      pricePerSeat: ride.pricePerSeat,
      preferences: {
        maxTwoInBackSeat: ride.maxTwoInBackSeat,
        noSmoking: ride.noSmoking,
        noPets: ride.noPets,
        luggageAllowed: ride.luggageAllowed,
        womenOnly: ride.womenOnly,
        notes: ride.notes,
      },
      vehicleId: ride.vehicleId,
      seriesId: ride.seriesId,
      occurrenceDate: ride.occurrenceDate,
      direction: ride.direction,
      assuredDepositPercentage: ride.assuredDepositPercentage,
      assuredDepositAmount: ride.assuredDepositAmount,
      driverDepositHoldId: ride.driverDepositHoldId,
      createdAt: ride.createdAt.toISOString(),
      updatedAt: ride.updatedAt.toISOString(),
      cancelledAt: ride.cancelledAt?.toISOString() ?? null,
      cancellationReason: ride.cancellationReason,
      cancelledByUserId: ride.cancelledByUserId,
      completedAt: ride.completedAt?.toISOString() ?? null,
    };
  }

  private collectedAmount(booking: Booking): string {
    if (booking.paymentStatus === BookingPaymentStatus.UNPAID) {
      return '0';
    }
    return booking.totalAmount;
  }

  private sumNullable(values: Array<string | null | undefined>): string {
    let total = 0n;
    for (const value of values) {
      if (value) {
        total += BigInt(value);
      }
    }
    return total.toString();
  }

  private mapWalletTx(tx: WalletTransaction) {
    return {
      id: tx.id,
      walletId: tx.walletId,
      userId: tx.userId,
      type: tx.transactionType,
      direction: tx.direction,
      status: tx.status,
      amount: tx.amount,
      referenceType: tx.referenceType,
      referenceId: tx.referenceId,
      parentTransactionId: tx.parentTransactionId ?? null,
      createdAt: tx.createdAt.toISOString(),
    };
  }

  private mapLocation(
    ride: Ride,
    bundle: Awaited<ReturnType<TrackingService['getStoredLocationsForRides']>>,
  ) {
    if (ride.status !== RideStatus.IN_PROGRESS) {
      return {
        status: 'NOT_IN_PROGRESS',
        latitude: null,
        longitude: null,
        timestamp: null,
        heading: null,
        speed: null,
      };
    }
    if (!bundle.redisReady) {
      return {
        status: 'MISSING',
        latitude: null,
        longitude: null,
        timestamp: null,
        heading: null,
        speed: null,
      };
    }
    const stored = bundle.locations.get(ride.id);
    if (!stored) {
      return {
        status: 'MISSING',
        latitude: null,
        longitude: null,
        timestamp: null,
        heading: null,
        speed: null,
      };
    }
    const ageMs = Date.now() - new Date(stored.updatedAt).getTime();
    return {
      status: ageMs > RIDE_TRACKING_STALE_AFTER_MS ? 'STALE' : 'AVAILABLE',
      latitude: stored.latitude,
      longitude: stored.longitude,
      timestamp: stored.updatedAt,
      heading: stored.heading ?? null,
      speed: stored.speed ?? null,
    };
  }
}
