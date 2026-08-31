import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import {
  Brackets,
  DataSource,
  EntityManager,
  In,
  QueryFailedError,
  Repository,
} from 'typeorm';

import {
  ASSURED_RIDE_DRIVER_DEPOSIT_REF,
  calculateDriverAssuredDeposit,
} from '../assured/assured-deposit.math';
import { AssuredGeographicQueueService } from '../assured/assured-geographic-queue.service';
import { AssuredLifecycleService } from '../assured/assured-lifecycle.service';
import { AssuredQueueService } from '../assured/assured-queue.service';
import {
  assertRideStartableForType,
  isAssuredBookableStatus,
  isAssuredPreTripOfferStatus,
  isAssuredSearchVisibleOffer,
  isCommutePublishedStatus,
  isRegularPublishedStatus,
} from '../assured/assured-ride-status';
import {
  AssuredRideLifecycleResponseDto,
  HalfTimeDecisionResponseDto,
} from '../assured/dto/assured-lifecycle-response.dto';
import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingCancellationReason,
  BookingMode,
  BookingPickupStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { BookingsService } from '../bookings/bookings.service';
import { CommuteSettlementService } from '../fare/commute-settlement.service';
import { FareSettlementService } from '../fare/fare-settlement.service';
import { SettingsService } from '../settings/settings.service';
import { TrackingService } from '../tracking/tracking.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { UserVerification } from '../verification/entities/user-verification.entity';
import { VerificationService } from '../verification/verification.service';
import {
  VerificationStatus,
  VerificationType,
} from '../verification/enums/verification.enums';
import {
  InsufficientWalletBalanceError,
  WalletHoldAlreadyConsumedError,
  WalletHoldNotActiveError,
  WalletNotFoundError,
} from '../wallet/errors/wallet.errors';
import {
  WalletHold,
  WalletHoldStatus,
  WalletHoldType,
} from '../wallet/entities/wallet-hold.entity';
import { Wallet, WalletStatus } from '../wallet/entities/wallet.entity';
import { WalletService } from '../wallet/wallet.service';
import { CompleteRideResponseDto } from './dto/complete-ride-response.dto';
import { CreateRideDto } from './dto/create-ride.dto';
import { RideHistoryQueryDto } from './dto/ride-history-query.dto';
import {
  RideHistoryDetailDto,
  RideHistoryEarningsDto,
  RideHistoryListItemDto,
  RideHistoryPageDto,
  RideHistoryPassengerDto,
  RideHistoryTripDto,
  RideHistoryVehicleDto,
} from './dto/ride-history-response.dto';
import { UpdateRideDto } from './dto/update-ride.dto';
import { RideResponseDto } from './dto/ride-response.dto';
import {
  RideSearchItemDto,
  RideSearchPageDto,
} from './dto/ride-search-response.dto';
import { SearchRidesDto } from './dto/search-rides.dto';
import { Ride } from './entities/ride.entity';
import {
  RegularSeatsPolicy,
  RideCancellationReason,
  RideStatus,
  RideType,
} from './enums/ride.enums';
import { supportsTripLifecycle } from './ride-trip-lifecycle';
import { computeCommuteRiderPricePerSeat } from './commute-fare.math';
import { computeCommuteRouteMatchPercentage } from './commute-route-match.math';
import { RideDirectionsService } from './route/ride-directions.service';
import {
  decodePolyline,
  isValidLatLng,
  LatLng,
  matchesRouteCorridor,
  ROUTE_CORRIDOR_MAX_METERS,
} from './route/route-geometry';

interface CommuteSearchRouteMatchContext {
  pickup: LatLng;
  dropoff: LatLng;
}

@Injectable()
export class RidesService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserProfile)
    private readonly userProfileRepository: Repository<UserProfile>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepository: Repository<Vehicle>,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(WalletHold)
    private readonly walletHoldRepository: Repository<WalletHold>,
    @InjectRepository(UserVerification)
    private readonly verificationRepository: Repository<UserVerification>,
    private readonly verificationService: VerificationService,
    private readonly walletService: WalletService,
    private readonly settingsService: SettingsService,
    private readonly assuredLifecycleService: AssuredLifecycleService,
    private readonly assuredQueueService: AssuredQueueService,
    private readonly assuredGeographicQueueService: AssuredGeographicQueueService,
    private readonly fareSettlementService: FareSettlementService,
    private readonly commuteSettlementService: CommuteSettlementService,
    private readonly bookingsService: BookingsService,
    private readonly trackingService: TrackingService,
    private readonly rideDirectionsService: RideDirectionsService,
  ) {}

  async cancelByDriver(
    driverId: string,
    rideId: string,
  ): Promise<AssuredRideLifecycleResponseDto> {
    const ride = await this.rideRepository.findOne({
      where: { id: rideId },
      select: { id: true, driverId: true, rideType: true },
    });

    if (!ride || ride.driverId !== driverId) {
      throw new NotFoundException('Ride not found');
    }

    if (ride.rideType === RideType.REGULAR) {
      return this.cancelRegularRideByDriver(driverId, rideId);
    }

    if (ride.rideType === RideType.ASSURED) {
      return this.assuredLifecycleService.cancelRideByDriver(driverId, rideId);
    }

    throw new BadRequestException(`Unsupported ride type: ${ride.rideType}`);
  }

  /**
   * Start a trip-lifecycle ride (Regular or Assured): PUBLISHED → IN_PROGRESS.
   * Zero confirmed passengers is allowed.
   */
  async startByDriver(
    driverId: string,
    rideId: string,
  ): Promise<RideResponseDto> {
    return this.dataSource.transaction(async (manager) => {
      const ride = await manager
        .getRepository(Ride)
        .createQueryBuilder('ride')
        .setLock('pessimistic_write')
        .where('ride.id = :rideId', { rideId })
        .getOne();

      if (!ride || ride.driverId !== driverId) {
        throw new NotFoundException('Ride not found');
      }

      if (!supportsTripLifecycle(ride.rideType)) {
        throw new BadRequestException(
          `Ride type ${ride.rideType} cannot be started via this endpoint`,
        );
      }

      if (ride.status === RideStatus.CANCELLED) {
        throw new ConflictException('Cancelled rides cannot be started');
      }

      if (ride.status === RideStatus.COMPLETED) {
        throw new ConflictException('Completed rides cannot be started');
      }

      if (ride.status === RideStatus.IN_PROGRESS) {
        throw new ConflictException('Ride is already in progress');
      }

      if (!assertRideStartableForType(ride.rideType, ride.status)) {
        throw new ConflictException(
          `Ride cannot be started from status ${ride.status}`,
        );
      }

      await this.bookingsService.ensurePickupOtpsForRideStart(manager, ride);

      ride.status = RideStatus.IN_PROGRESS;
      const saved = await manager.getRepository(Ride).save(ride);
      return this.toResponse(saved);
    });
  }

  /**
   * Regular ride driver cancellation: cancel the ride and all active bookings.
   * No Assured deposit / wallet lifecycle. PAY_NOW wallet debits are not refunded
   * (no booking-refund mechanism exists in the current payment architecture).
   */
  private async cancelRegularRideByDriver(
    driverId: string,
    rideId: string,
  ): Promise<AssuredRideLifecycleResponseDto> {
    const result = await this.dataSource.transaction(async (manager) => {
      const ride = await manager
        .getRepository(Ride)
        .createQueryBuilder('ride')
        .setLock('pessimistic_write')
        .where('ride.id = :rideId', { rideId })
        .getOne();

      if (!ride || ride.driverId !== driverId) {
        throw new NotFoundException('Ride not found');
      }

      if (ride.rideType !== RideType.REGULAR) {
        throw new BadRequestException('Ride is not a Regular ride');
      }

      if (ride.status === RideStatus.COMPLETED) {
        throw new ConflictException('Completed rides cannot be cancelled');
      }

      if (ride.status === RideStatus.CANCELLED) {
        if (
          ride.cancellationReason === RideCancellationReason.DRIVER_CANCELLED
        ) {
          const cancelledBookingCount = await manager
            .getRepository(Booking)
            .count({
              where: {
                rideId: ride.id,
                status: BookingStatus.CANCELLED,
                cancellationReason: BookingCancellationReason.RIDE_CANCELLED,
              },
            });
          return {
            rideId: ride.id,
            status: ride.status,
            cancellationReason: ride.cancellationReason,
            cancelledBookingCount,
            driverDepositForfeited: null,
            riderCompensationTotal: '0',
            platformForfeiture: '0',
            fareRefundedTotal: '0',
            couponsIssuedCount: 0,
            alreadyApplied: true,
          };
        }
        throw new ConflictException(
          `Ride is already cancelled (${ride.cancellationReason})`,
        );
      }

      if (ride.status !== RideStatus.PUBLISHED) {
        throw new ConflictException(
          `Ride cannot be cancelled from status ${ride.status}`,
        );
      }

      const now = new Date();
      const activeBookings = await manager.getRepository(Booking).find({
        where: {
          rideId: ride.id,
          status: In([BookingStatus.PENDING, BookingStatus.CONFIRMED]),
        },
        order: { createdAt: 'ASC', id: 'ASC' },
      });

      for (const booking of activeBookings) {
        booking.status = BookingStatus.CANCELLED;
        booking.cancellationReason = BookingCancellationReason.RIDE_CANCELLED;
        booking.cancelledAt = now;
        await manager.getRepository(Booking).save(booking);
      }

      // Do not restore availableSeats — the ride is cancelled and unbookable.
      ride.status = RideStatus.CANCELLED;
      ride.cancellationReason = RideCancellationReason.DRIVER_CANCELLED;
      ride.cancelledByUserId = driverId;
      ride.cancelledAt = now;
      await manager.getRepository(Ride).save(ride);

      return {
        rideId: ride.id,
        status: ride.status,
        cancellationReason: ride.cancellationReason,
        cancelledBookingCount: activeBookings.length,
        driverDepositForfeited: null,
        riderCompensationTotal: '0',
        platformForfeiture: '0',
        fareRefundedTotal: '0',
        couponsIssuedCount: 0,
        alreadyApplied: false,
      };
    });

    await this.trackingService.clearRideTracking(rideId, 'cancel');
    return result;
  }

  async reportDriverNoShow(
    passengerId: string,
    rideId: string,
  ): Promise<AssuredRideLifecycleResponseDto> {
    return this.assuredLifecycleService.reportDriverNoShow(passengerId, rideId);
  }

  async decideRegularSeatsPolicy(
    driverId: string,
    rideId: string,
    policy: RegularSeatsPolicy,
  ): Promise<HalfTimeDecisionResponseDto> {
    return this.assuredLifecycleService.decideRegularSeatsPolicy(
      driverId,
      rideId,
      policy,
    );
  }

  async create(
    driverId: string,
    dto: CreateRideDto,
    options?: { idempotencyKey?: string | null },
  ): Promise<RideResponseDto> {
    await this.assertDriverCanPublish(driverId, dto.vehicleId);

    if (dto.rideType === RideType.ASSURED) {
      return this.createAssuredRide(driverId, dto, options?.idempotencyKey);
    }

    if (dto.rideType === RideType.COMMUTE) {
      return this.createCommuteRide(driverId, dto);
    }

    return this.createRegularRide(driverId, dto);
  }

  private async createRegularRide(
    driverId: string,
    dto: CreateRideDto,
  ): Promise<RideResponseDto> {
    const routeFields = await this.buildRouteFieldsFromDto({
      source: dto.source,
      destination: dto.destination,
      sourceLatitude: dto.sourceLatitude,
      sourceLongitude: dto.sourceLongitude,
      destinationLatitude: dto.destinationLatitude,
      destinationLongitude: dto.destinationLongitude,
    });

    const ride = this.rideRepository.create({
      driverId,
      vehicleId: dto.vehicleId,
      rideType: RideType.REGULAR,
      status: RideStatus.PUBLISHED,
      source: dto.source.trim(),
      destination: dto.destination.trim(),
      departureDate: dto.departureDate,
      departureTime: this.normalizeTime(dto.departureTime),
      totalSeats: dto.totalSeats,
      availableSeats: dto.totalSeats,
      pricePerSeat: String(dto.pricePerSeat),
      maxTwoInBackSeat: dto.maxTwoInBackSeat ?? false,
      noSmoking: dto.noSmoking ?? false,
      noPets: dto.noPets ?? false,
      luggageAllowed: dto.luggageAllowed ?? true,
      notes: dto.notes?.trim() ?? null,
      assuredDepositPercentage: null,
      assuredDepositAmount: null,
      driverDepositHoldId: null,
      publishIdempotencyKey: null,
      ...routeFields,
    });

    const saved = await this.rideRepository.save(ride);
    return this.toResponse(saved);
  }

  private async createCommuteRide(
    driverId: string,
    dto: CreateRideDto,
  ): Promise<RideResponseDto> {
    const routeFields = await this.buildRouteFieldsFromDto({
      source: dto.source,
      destination: dto.destination,
      sourceLatitude: dto.sourceLatitude,
      sourceLongitude: dto.sourceLongitude,
      destinationLatitude: dto.destinationLatitude,
      destinationLongitude: dto.destinationLongitude,
    });

    const ride = this.rideRepository.create({
      driverId,
      vehicleId: dto.vehicleId,
      rideType: RideType.COMMUTE,
      status: RideStatus.PUBLISHED,
      source: dto.source.trim(),
      destination: dto.destination.trim(),
      departureDate: dto.departureDate,
      departureTime: this.normalizeTime(dto.departureTime),
      totalSeats: dto.totalSeats,
      availableSeats: dto.totalSeats,
      pricePerSeat: String(dto.pricePerSeat),
      maxTwoInBackSeat: dto.maxTwoInBackSeat ?? false,
      noSmoking: dto.noSmoking ?? false,
      noPets: dto.noPets ?? false,
      luggageAllowed: dto.luggageAllowed ?? true,
      notes: dto.notes?.trim() ?? null,
      assuredDepositPercentage: null,
      assuredDepositAmount: null,
      driverDepositHoldId: null,
      publishIdempotencyKey: null,
      ...routeFields,
    });

    const saved = await this.rideRepository.save(ride);
    return this.toResponse(saved);
  }

  /**
   * Assured publish: resolve geometry outside the wallet lock, then atomic
   * Wallet → Balance → Lots → geographic queue → enqueue → Ride.
   * When Idempotency-Key is supplied, retries with the same key are safe.
   */
  private async createAssuredRide(
    driverId: string,
    dto: CreateRideDto,
    idempotencyKey: string | null | undefined,
  ): Promise<RideResponseDto> {
    const clientKey = idempotencyKey?.trim() || null;
    if (clientKey && clientKey.length > 255) {
      throw new BadRequestException(
        'Idempotency-Key must be at most 255 characters',
      );
    }
    // Prefer client key for retry safety; otherwise generate a unique key so
    // the column remains populated for Assured rows (no silent Regular-style null).
    const key = clientKey ?? `assured-publish:${randomUUID()}`;

    if (clientKey) {
      const existing = await this.rideRepository.findOne({
        where: { publishIdempotencyKey: key },
      });
      if (existing) {
        this.assertAssuredPublishIdempotentMatches(existing, driverId, dto);
        return this.toResponse(existing);
      }
    }

    this.assertAssuredPublishCoordinates(dto);

    // Resolve geometry before opening the wallet transaction so Directions
    // latency does not hold financial locks, and geometry failures never
    // create a deposit hold.
    const routeFields = await this.buildRouteFieldsFromDto({
      source: dto.source,
      destination: dto.destination,
      sourceLatitude: dto.sourceLatitude,
      sourceLongitude: dto.sourceLongitude,
      destinationLatitude: dto.destinationLatitude,
      destinationLongitude: dto.destinationLongitude,
      allowPlaceNameFallback: false,
    });
    this.assertAssuredRouteGeometryForQueue(routeFields);

    const percentage =
      await this.settingsService.getAssuredRideDepositPercentage();
    const pricePerSeat = BigInt(dto.pricePerSeat);
    const depositAmount = calculateDriverAssuredDeposit(
      dto.totalSeats,
      pricePerSeat,
      percentage,
    );
    const rideId = randomUUID();
    const depositLedgerKey = `assured-driver-deposit:${rideId}`;

    try {
      return await this.dataSource.transaction(async (manager) => {
        if (clientKey) {
          const existingAfterLock = await manager.getRepository(Ride).findOne({
            where: { publishIdempotencyKey: key },
          });
          if (existingAfterLock) {
            this.assertAssuredPublishIdempotentMatches(
              existingAfterLock,
              driverId,
              dto,
            );
            return this.toResponse(existingAfterLock);
          }
        }

        const wallet = await this.lockWalletForUpdate(manager, driverId);
        this.assertWalletAllowsDeposit(wallet);

        let driverDepositHoldId: string | null = null;
        if (depositAmount > 0n) {
          const holdResult = await this.walletService.createHoldInTransaction(
            manager,
            {
              walletId: wallet.id,
              amount: depositAmount,
              holdType: WalletHoldType.ASSURED_DEPOSIT,
              referenceType: ASSURED_RIDE_DRIVER_DEPOSIT_REF,
              referenceId: rideId,
              idempotencyKey: depositLedgerKey,
            },
          );
          driverDepositHoldId = holdResult.hold!.id;
        }

        const ride = manager.getRepository(Ride).create({
          id: rideId,
          driverId,
          vehicleId: dto.vehicleId,
          rideType: RideType.ASSURED,
          source: dto.source.trim(),
          destination: dto.destination.trim(),
          departureDate: dto.departureDate,
          departureTime: this.normalizeTime(dto.departureTime),
          totalSeats: dto.totalSeats,
          availableSeats: dto.totalSeats,
          pricePerSeat: String(dto.pricePerSeat),
          maxTwoInBackSeat: dto.maxTwoInBackSeat ?? false,
          noSmoking: dto.noSmoking ?? false,
          noPets: dto.noPets ?? false,
          luggageAllowed: dto.luggageAllowed ?? true,
          notes: dto.notes?.trim() ?? null,
          assuredDepositPercentage: percentage,
          assuredDepositAmount: depositAmount.toString(),
          driverDepositHoldId,
          publishIdempotencyKey: key,
          ...routeFields,
        });

        await this.assuredGeographicQueueService.assignGeographicQueueInTransaction(
          manager,
          ride,
        );
        await this.assuredQueueService.enqueueAssuredRideInTransaction(
          manager,
          ride,
        );

        const saved =
          await this.assuredQueueService.saveNewAssuredRideInTransaction(
            manager,
            ride,
          );
        return this.toResponse(saved);
      });
    } catch (error) {
      if (clientKey && this.isAssuredPublishIdempotencyUniqueViolation(error)) {
        const recovered = await this.rideRepository.findOne({
          where: { publishIdempotencyKey: key },
        });
        if (recovered) {
          this.assertAssuredPublishIdempotentMatches(recovered, driverId, dto);
          return this.toResponse(recovered);
        }
      }
      throw error;
    }
  }

  private assertAssuredPublishCoordinates(dto: CreateRideDto): void {
    if (dto.sourceLatitude == null || dto.sourceLongitude == null) {
      throw new BadRequestException(
        'Assured ride publishing requires source coordinates',
      );
    }
    if (dto.destinationLatitude == null || dto.destinationLongitude == null) {
      throw new BadRequestException(
        'Assured ride publishing requires destination coordinates',
      );
    }
  }

  private assertAssuredPublishIdempotentMatches(
    existing: Ride,
    driverId: string,
    dto: CreateRideDto,
  ): void {
    if (
      existing.driverId !== driverId ||
      existing.rideType !== RideType.ASSURED ||
      existing.vehicleId !== dto.vehicleId ||
      existing.source.trim() !== dto.source.trim() ||
      existing.destination.trim() !== dto.destination.trim() ||
      this.toCivilDate(existing.departureDate) !== dto.departureDate ||
      this.formatTime(existing.departureTime) !==
        this.normalizeTime(dto.departureTime) ||
      existing.totalSeats !== dto.totalSeats ||
      existing.pricePerSeat !== String(dto.pricePerSeat)
    ) {
      throw new ConflictException(
        'Idempotency key was reused for a different Assured publish request',
      );
    }
  }

  private isAssuredPublishIdempotencyUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const driverError = error.driverError as {
      code?: string;
      constraint?: string;
      detail?: string;
    };
    const code = driverError?.code ?? (error as { code?: string }).code;
    const constraint =
      driverError?.constraint ??
      (error as { constraint?: string }).constraint ??
      '';
    const detail = driverError?.detail ?? '';
    return (
      code === '23505' &&
      (constraint.includes('publish_idempotency') ||
        detail.includes('publish_idempotency_key'))
    );
  }

  async findMine(driverId: string): Promise<RideResponseDto[]> {
    const rides = await this.rideRepository.find({
      where: { driverId },
      order: { departureDate: 'ASC', departureTime: 'ASC', createdAt: 'DESC' },
    });
    return rides.map((ride) => this.toResponse(ride));
  }

  /**
   * Paginated past rides for the owning driver (COMPLETED / CANCELLED only).
   * Does not include PUBLISHED or IN_PROGRESS.
   */
  async findHistory(
    driverId: string,
    query: RideHistoryQueryDto,
  ): Promise<RideHistoryPageDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const statuses = query.status
      ? [query.status]
      : [RideStatus.COMPLETED, RideStatus.CANCELLED];

    const qb = this.rideRepository
      .createQueryBuilder('ride')
      .where('ride.driver_id = :driverId', { driverId })
      .andWhere('ride.status IN (:...statuses)', { statuses })
      .orderBy('ride.departure_date', 'DESC')
      .addOrderBy('ride.departure_time', 'DESC')
      .addOrderBy('ride.updated_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rides, total] = await qb.getManyAndCount();
    const items = await this.toHistoryListItems(rides);

    return {
      items,
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /**
   * Driver past-ride detail with passengers and earnings from real bookings.
   */
  async findHistoryDetail(
    driverId: string,
    rideId: string,
  ): Promise<RideHistoryDetailDto> {
    const ride = await this.rideRepository.findOne({
      where: { id: rideId, driverId },
    });
    if (
      !ride ||
      (ride.status !== RideStatus.COMPLETED &&
        ride.status !== RideStatus.CANCELLED)
    ) {
      throw new NotFoundException('Ride not found');
    }

    const bookings = await this.bookingRepository.find({
      where: { rideId: ride.id },
      order: { pickupOrder: 'ASC', createdAt: 'ASC', id: 'ASC' },
    });

    const passengerIds = [
      ...new Set(bookings.map((booking) => booking.passengerId)),
    ];
    const profiles =
      passengerIds.length === 0
        ? []
        : await this.userProfileRepository.find({
            where: { userId: In(passengerIds) },
          });
    const profileByUserId = new Map(
      profiles.map((profile) => [profile.userId, profile] as const),
    );

    const vehicle = await this.vehicleRepository.findOne({
      where: { id: ride.vehicleId },
      withDeleted: true,
    });
    const vehicleVerified = vehicle
      ? await this.isVerificationCurrentlyVerified(
          vehicle.userId,
          VerificationType.VEHICLE,
        )
      : false;

    const passengers: RideHistoryPassengerDto[] = bookings.map((booking) => {
      const profile = profileByUserId.get(booking.passengerId);
      return {
        bookingId: booking.id,
        userId: booking.passengerId,
        name: profile?.displayName ?? profile?.firstName ?? null,
        profileImage: profile?.profilePhoto ?? null,
        fare: booking.totalAmount,
        seats: booking.seats,
        bookingStatus: booking.status,
      };
    });

    const bookedSeats = bookings
      .filter((booking) =>
        [
          BookingStatus.PENDING,
          BookingStatus.CONFIRMED,
          BookingStatus.COMPLETED,
        ].includes(booking.status),
      )
      .reduce((sum, booking) => sum + booking.seats, 0);

    return {
      ride: this.toHistoryTrip(ride, bookedSeats),
      vehicle: vehicle
        ? this.toHistoryVehicle(vehicle, vehicleVerified)
        : null,
      passengers,
      earnings: this.calculateHistoryEarnings(bookings),
    };
  }

  async findOne(requesterId: string, rideId: string): Promise<RideResponseDto> {
    const ride = await this.requireOwnedRide(requesterId, rideId);
    return this.toResponse(ride);
  }

  /**
   * Passenger-facing published ride detail.
   * Does not reveal existence of non-published / other internal rides.
   */
  async findPublishedPublic(rideId: string): Promise<RideSearchItemDto> {
    const ride = await this.rideRepository.findOne({
      where: { id: rideId },
    });
    if (!ride || !this.isPassengerVisibleRide(ride)) {
      throw new NotFoundException('Ride not found');
    }

    const [item] = await this.toSearchItems([ride]);
    return item;
  }

  private resolveCommuteRouteMatchPercentage(
    ride: Ride,
    routeMatch?: CommuteSearchRouteMatchContext,
  ): number | undefined {
    if (
      ride.rideType !== RideType.COMMUTE ||
      !routeMatch ||
      !ride.routePolyline
    ) {
      return undefined;
    }
    try {
      const routePoints = decodePolyline(ride.routePolyline);
      const score = computeCommuteRouteMatchPercentage({
        routePoints,
        pickup: routeMatch.pickup,
        dropoff: routeMatch.dropoff,
        driverPickup:
          ride.sourceLatitude != null && ride.sourceLongitude != null
            ? {
                latitude: ride.sourceLatitude,
                longitude: ride.sourceLongitude,
              }
            : null,
        driverDropoff:
          ride.destinationLatitude != null && ride.destinationLongitude != null
            ? {
                latitude: ride.destinationLatitude,
                longitude: ride.destinationLongitude,
              }
            : null,
      });
      return score ?? undefined;
    } catch {
      return undefined;
    }
  }

  async search(dto: SearchRidesDto): Promise<RideSearchPageDto> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const useCorridor = this.hasCompleteSearchCoordinates(dto);

    if (useCorridor) {
      await this.backfillMissingRouteGeometryForSearch(dto);
    }

    const qb = this.rideRepository
      .createQueryBuilder('ride')
      .where('ride.departure_date = :date', { date: dto.date });
    this.applyPassengerVisibilityFilter(qb);

    if (dto.rideType !== undefined) {
      qb.andWhere('ride.ride_type = :rideType', { rideType: dto.rideType });
    }

    if (dto.time) {
      qb.andWhere('ride.departure_time >= :time', {
        time: this.normalizeTime(dto.time),
      });
    }

    if (dto.seats !== undefined) {
      qb.andWhere('ride.available_seats >= :seats', { seats: dto.seats });
    }

    if (!useCorridor) {
      qb.andWhere('LOWER(ride.source) LIKE LOWER(:source)', {
        source: `%${dto.source.trim()}%`,
      }).andWhere('LOWER(ride.destination) LIKE LOWER(:destination)', {
        destination: `%${dto.destination.trim()}%`,
      });

      qb.orderBy('ride.departure_date', 'ASC')
        .addOrderBy('ride.departure_time', 'ASC')
        .addOrderBy('ride.created_at', 'ASC')
        .skip((page - 1) * limit)
        .take(limit);

      const [rides, total] = await qb.getManyAndCount();
      const items = await this.toSearchItems(rides);

      return {
        items,
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      };
    }

    const pickup: LatLng = {
      latitude: dto.pickupLatitude!,
      longitude: dto.pickupLongitude!,
    };
    const dropoff: LatLng = {
      latitude: dto.dropoffLatitude!,
      longitude: dto.dropoffLongitude!,
    };
    const midLat = (pickup.latitude + dropoff.latitude) / 2;
    const latPad = ROUTE_CORRIDOR_MAX_METERS / 111_320;
    const cos = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
    const lngPad = ROUTE_CORRIDOR_MAX_METERS / (111_320 * cos);

    qb.andWhere(
      new Brackets((where) => {
        where
          .where(
            `
            ride.route_polyline IS NOT NULL
            AND ride.route_bbox_min_lat IS NOT NULL
            AND :pickupLat BETWEEN (ride.route_bbox_min_lat - :latPad)
              AND (ride.route_bbox_max_lat + :latPad)
            AND :pickupLng BETWEEN (ride.route_bbox_min_lng - :lngPad)
              AND (ride.route_bbox_max_lng + :lngPad)
            AND :dropoffLat BETWEEN (ride.route_bbox_min_lat - :latPad)
              AND (ride.route_bbox_max_lat + :latPad)
            AND :dropoffLng BETWEEN (ride.route_bbox_min_lng - :lngPad)
              AND (ride.route_bbox_max_lng + :lngPad)
            `,
            {
              pickupLat: pickup.latitude,
              pickupLng: pickup.longitude,
              dropoffLat: dropoff.latitude,
              dropoffLng: dropoff.longitude,
              latPad,
              lngPad,
            },
          )
          .orWhere(
            `
            ride.route_polyline IS NULL
            AND LOWER(ride.source) LIKE LOWER(:legacySource)
            AND LOWER(ride.destination) LIKE LOWER(:legacyDestination)
            `,
            {
              legacySource: `%${dto.source.trim()}%`,
              legacyDestination: `%${dto.destination.trim()}%`,
            },
          );
      }),
    );

    qb.orderBy('ride.departure_date', 'ASC')
      .addOrderBy('ride.departure_time', 'ASC')
      .addOrderBy('ride.created_at', 'ASC')
      .take(500);

    const candidates = await qb.getMany();
    const matched = candidates.filter((ride) =>
      this.rideMatchesCorridorSearch(ride, pickup, dropoff),
    );

    const total = matched.length;
    const pageRides = matched.slice((page - 1) * limit, page * limit);
    const items = await this.toSearchItems(pageRides, { pickup, dropoff });

    return {
      items,
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async update(
    driverId: string,
    rideId: string,
    dto: UpdateRideDto,
  ): Promise<RideResponseDto> {
    return this.dataSource.transaction(async (manager) => {
      const ride = await manager
        .getRepository(Ride)
        .createQueryBuilder('ride')
        .setLock('pessimistic_write')
        .where('ride.id = :rideId', { rideId })
        .getOne();

      if (!ride || ride.driverId !== driverId) {
        throw new NotFoundException('Ride not found');
      }

      if (ride.rideType === RideType.REGULAR || ride.rideType === RideType.COMMUTE) {
        await this.applyRegularRideUpdate(manager, driverId, ride, dto);
      } else {
        await this.applyAssuredRideUpdate(manager, driverId, ride, dto);
      }

      const saved = await manager.getRepository(Ride).save(ride);
      return this.toResponse(saved);
    });
  }

  private async applyRegularRideUpdate(
    manager: EntityManager,
    driverId: string,
    ride: Ride,
    dto: UpdateRideDto,
  ): Promise<void> {
    if (ride.status !== RideStatus.PUBLISHED) {
      if (ride.status === RideStatus.IN_PROGRESS) {
        throw new ConflictException(
          'Ride cannot be modified after it has started.',
        );
      }
      if (ride.status === RideStatus.COMPLETED) {
        throw new ConflictException('Completed rides cannot be modified.');
      }
      if (ride.status === RideStatus.CANCELLED) {
        throw new ConflictException('Cancelled rides cannot be modified.');
      }
      throw new ConflictException(
        `Ride cannot be modified from status ${ride.status}`,
      );
    }

    const bookedSeats = await this.sumActiveBookedSeats(manager, ride.id);

    if (bookedSeats > 0) {
      this.assertRegularProtectedFieldsUnchanged(ride, dto);
    }

    if (dto.totalSeats !== undefined) {
      if (dto.totalSeats < bookedSeats) {
        throw new BadRequestException(
          'Seats cannot be reduced below the number of booked seats.',
        );
      }
      ride.availableSeats = dto.totalSeats - bookedSeats;
      ride.totalSeats = dto.totalSeats;
    }

    if (bookedSeats === 0) {
      await this.applyUnrestrictedRideFields(driverId, ride, dto);
    }
  }

  private async applyAssuredRideUpdate(
    manager: EntityManager,
    driverId: string,
    ride: Ride,
    dto: UpdateRideDto,
  ): Promise<void> {
    if (!isAssuredPreTripOfferStatus(ride.status)) {
      if (ride.status === RideStatus.IN_PROGRESS) {
        throw new ConflictException(
          'Ride cannot be modified after it has started.',
        );
      }
      if (ride.status === RideStatus.COMPLETED) {
        throw new ConflictException('Completed rides cannot be modified.');
      }
      if (ride.status === RideStatus.CANCELLED) {
        throw new ConflictException('Cancelled rides cannot be modified.');
      }
      throw new ConflictException(
        `Ride cannot be modified from status ${ride.status}`,
      );
    }

    if (ride.status === RideStatus.ASSURANCE_ACTIVE) {
      this.assertAssuredActiveQueueFieldsUnchanged(ride, dto);
    }

    const previousQueueId = ride.assuredQueueId;

    if (ride.driverDepositHoldId !== null) {
      const priceChanging =
        dto.pricePerSeat !== undefined &&
        String(dto.pricePerSeat) !== ride.pricePerSeat;
      const seatsChanging =
        dto.totalSeats !== undefined && dto.totalSeats !== ride.totalSeats;
      const typeChanging =
        dto.rideType !== undefined && dto.rideType !== RideType.ASSURED;

      if (priceChanging || seatsChanging || typeChanging) {
        throw new ConflictException(
          'Assured ride price/seat capacity cannot change while an active driver deposit exists; use a future deposit adjustment workflow',
        );
      }
    }

    const bookedSeats = await this.sumActiveBookedSeats(manager, ride.id);
    if (dto.totalSeats !== undefined) {
      if (dto.totalSeats < bookedSeats) {
        throw new ForbiddenException(
          'totalSeats cannot be less than already reserved seats',
        );
      }
      ride.availableSeats = dto.totalSeats - bookedSeats;
      ride.totalSeats = dto.totalSeats;
    }

    await this.applyUnrestrictedRideFields(driverId, ride, dto, {
      skipSeats: true,
    });

    if (ride.status === RideStatus.ASSURANCE_PENDING) {
      this.assertAssuredRouteGeometryForQueue({
        sourceLatitude: ride.sourceLatitude,
        sourceLongitude: ride.sourceLongitude,
        destinationLatitude: ride.destinationLatitude,
        destinationLongitude: ride.destinationLongitude,
        routePolyline: ride.routePolyline,
      });
      await this.assuredGeographicQueueService.assignGeographicQueueInTransaction(
        manager,
        ride,
      );
      if (previousQueueId !== ride.assuredQueueId) {
        await this.assuredQueueService.requeuePendingRideInTransaction(
          manager,
          ride,
          previousQueueId,
        );
      }
    }
  }

  private assertAssuredActiveQueueFieldsUnchanged(
    ride: Ride,
    dto: UpdateRideDto,
  ): void {
    const queueFieldsChanged =
      this.hasStringChange(dto.source, ride.source) ||
      this.hasStringChange(dto.destination, ride.destination) ||
      this.hasCoordinateChange(dto.sourceLatitude, ride.sourceLatitude) ||
      this.hasCoordinateChange(dto.sourceLongitude, ride.sourceLongitude) ||
      this.hasCoordinateChange(
        dto.destinationLatitude,
        ride.destinationLatitude,
      ) ||
      this.hasCoordinateChange(
        dto.destinationLongitude,
        ride.destinationLongitude,
      ) ||
      (dto.departureDate !== undefined &&
        this.toCivilDate(dto.departureDate) !==
          this.toCivilDate(ride.departureDate)) ||
      (dto.departureTime !== undefined &&
        this.normalizeTime(dto.departureTime) !==
          this.normalizeTime(ride.departureTime));

    if (queueFieldsChanged) {
      throw new ConflictException(
        'Active Assured rides cannot change route or departure schedule',
      );
    }
  }

  private isPassengerVisibleRide(ride: Ride): boolean {
    if (ride.rideType === RideType.ASSURED) {
      return isAssuredSearchVisibleOffer(ride.status, ride.availableSeats);
    }
    if (ride.rideType === RideType.COMMUTE) {
      return isCommutePublishedStatus(ride.status);
    }
    return isRegularPublishedStatus(ride.status);
  }

  private applyPassengerVisibilityFilter(
    qb: ReturnType<Repository<Ride>['createQueryBuilder']>,
  ): void {
    qb.andWhere(
      new Brackets((visibility) => {
        visibility
          .where(
            '(ride.ride_type = :regularType AND ride.status = :publishedStatus)',
            {
              regularType: RideType.REGULAR,
              publishedStatus: RideStatus.PUBLISHED,
            },
          )
          .orWhere(
            '(ride.ride_type = :commuteType AND ride.status = :commutePublishedStatus)',
            {
              commuteType: RideType.COMMUTE,
              commutePublishedStatus: RideStatus.PUBLISHED,
            },
          )
          .orWhere(
            '(ride.ride_type = :assuredType AND ride.status = :assuredActiveStatus AND ride.available_seats > 0)',
            {
              assuredType: RideType.ASSURED,
              assuredActiveStatus: RideStatus.ASSURANCE_ACTIVE,
            },
          );
      }),
    );
  }

  private async applyUnrestrictedRideFields(
    driverId: string,
    ride: Ride,
    dto: UpdateRideDto,
    options: { skipSeats?: boolean } = {},
  ): Promise<void> {
    if (dto.vehicleId !== undefined && dto.vehicleId !== ride.vehicleId) {
      await this.assertDriverCanPublish(driverId, dto.vehicleId);
      ride.vehicleId = dto.vehicleId;
    }

    if (dto.rideType !== undefined) {
      ride.rideType = dto.rideType;
    }
    if (dto.source !== undefined) {
      ride.source = dto.source.trim();
    }
    if (dto.destination !== undefined) {
      ride.destination = dto.destination.trim();
    }
    if (dto.departureDate !== undefined) {
      ride.departureDate = dto.departureDate;
    }
    if (dto.departureTime !== undefined) {
      ride.departureTime = this.normalizeTime(dto.departureTime);
    }
    if (!options.skipSeats && dto.totalSeats !== undefined) {
      const bookedSeats = ride.totalSeats - ride.availableSeats;
      if (dto.totalSeats < bookedSeats) {
        throw new ForbiddenException(
          'totalSeats cannot be less than already reserved seats',
        );
      }
      ride.availableSeats = dto.totalSeats - bookedSeats;
      ride.totalSeats = dto.totalSeats;
    }
    if (dto.pricePerSeat !== undefined) {
      ride.pricePerSeat = String(dto.pricePerSeat);
    }
    if (dto.maxTwoInBackSeat !== undefined) {
      ride.maxTwoInBackSeat = dto.maxTwoInBackSeat;
    }
    if (dto.noSmoking !== undefined) {
      ride.noSmoking = dto.noSmoking;
    }
    if (dto.noPets !== undefined) {
      ride.noPets = dto.noPets;
    }
    if (dto.luggageAllowed !== undefined) {
      ride.luggageAllowed = dto.luggageAllowed;
    }
    if (dto.notes !== undefined) {
      ride.notes = dto.notes?.trim() ?? null;
    }

    const routeRelatedChange =
      dto.source !== undefined ||
      dto.destination !== undefined ||
      dto.sourceLatitude !== undefined ||
      dto.sourceLongitude !== undefined ||
      dto.destinationLatitude !== undefined ||
      dto.destinationLongitude !== undefined;

    if (routeRelatedChange) {
      this.assertDtoEndpointCoordsAllOrNone(dto);
      const coordsProvidedInDto =
        dto.sourceLatitude !== undefined ||
        dto.sourceLongitude !== undefined ||
        dto.destinationLatitude !== undefined ||
        dto.destinationLongitude !== undefined;
      const placeTextChanged =
        dto.source !== undefined || dto.destination !== undefined;

      let routeFields;
      if (coordsProvidedInDto) {
        routeFields = await this.buildRouteFieldsFromDto({
          source: dto.source !== undefined ? dto.source : ride.source,
          destination:
            dto.destination !== undefined ? dto.destination : ride.destination,
          sourceLatitude: dto.sourceLatitude,
          sourceLongitude: dto.sourceLongitude,
          destinationLatitude: dto.destinationLatitude,
          destinationLongitude: dto.destinationLongitude,
          allowPlaceNameFallback: false,
        });
      } else if (placeTextChanged) {
        // Place labels changed without new coords — rebuild from names (drop stale geometry).
        routeFields = await this.buildRouteFieldsFromDto({
          source: ride.source,
          destination: ride.destination,
          allowPlaceNameFallback: true,
        });
      } else {
        routeFields = await this.buildRouteFieldsFromEndpoints({
          sourceLatitude: ride.sourceLatitude,
          sourceLongitude: ride.sourceLongitude,
          destinationLatitude: ride.destinationLatitude,
          destinationLongitude: ride.destinationLongitude,
        });
      }
      Object.assign(ride, routeFields);
    }
  }

  private assertRegularProtectedFieldsUnchanged(
    ride: Ride,
    dto: UpdateRideDto,
  ): void {
    const protectedChanged =
      this.hasStringChange(dto.source, ride.source) ||
      this.hasStringChange(dto.destination, ride.destination) ||
      this.hasCoordinateChange(dto.sourceLatitude, ride.sourceLatitude) ||
      this.hasCoordinateChange(dto.sourceLongitude, ride.sourceLongitude) ||
      this.hasCoordinateChange(
        dto.destinationLatitude,
        ride.destinationLatitude,
      ) ||
      this.hasCoordinateChange(
        dto.destinationLongitude,
        ride.destinationLongitude,
      ) ||
      (dto.departureDate !== undefined &&
        this.toCivilDate(dto.departureDate) !==
          this.toCivilDate(ride.departureDate)) ||
      (dto.departureTime !== undefined &&
        this.normalizeTime(dto.departureTime) !==
          this.normalizeTime(ride.departureTime)) ||
      (dto.pricePerSeat !== undefined &&
        String(dto.pricePerSeat) !== ride.pricePerSeat) ||
      (dto.vehicleId !== undefined && dto.vehicleId !== ride.vehicleId) ||
      (dto.rideType !== undefined && dto.rideType !== ride.rideType) ||
      (dto.maxTwoInBackSeat !== undefined &&
        dto.maxTwoInBackSeat !== ride.maxTwoInBackSeat) ||
      (dto.noSmoking !== undefined && dto.noSmoking !== ride.noSmoking) ||
      (dto.noPets !== undefined && dto.noPets !== ride.noPets) ||
      (dto.luggageAllowed !== undefined &&
        dto.luggageAllowed !== ride.luggageAllowed) ||
      (dto.notes !== undefined &&
        (dto.notes?.trim() ?? null) !== (ride.notes?.trim() ?? null));

    if (protectedChanged) {
      throw new ConflictException(
        'Ride details cannot be modified after a booking has been made. Only seats can be changed.',
      );
    }
  }

  private hasStringChange(
    incoming: string | undefined,
    current: string,
  ): boolean {
    return incoming !== undefined && incoming.trim() !== current.trim();
  }

  private hasCoordinateChange(
    incoming: number | undefined,
    current: number | null,
  ): boolean {
    if (incoming === undefined) {
      return false;
    }
    if (current === null) {
      return true;
    }
    return Math.abs(incoming - current) > 1e-7;
  }

  private hasCompleteSearchCoordinates(dto: SearchRidesDto): boolean {
    return (
      dto.pickupLatitude !== undefined &&
      dto.pickupLongitude !== undefined &&
      dto.dropoffLatitude !== undefined &&
      dto.dropoffLongitude !== undefined
    );
  }

  private rideMatchesCorridorSearch(
    ride: Ride,
    pickup: LatLng,
    dropoff: LatLng,
  ): boolean {
    if (!ride.routePolyline) {
      // Legacy rides without geometry already passed LIKE source/destination SQL.
      return true;
    }
    try {
      const routePoints = decodePolyline(ride.routePolyline);
      return matchesRouteCorridor({ routePoints, pickup, dropoff });
    } catch {
      return false;
    }
  }

  private assertDtoEndpointCoordsAllOrNone(dto: {
    sourceLatitude?: number;
    sourceLongitude?: number;
    destinationLatitude?: number;
    destinationLongitude?: number;
  }): void {
    const values = [
      dto.sourceLatitude,
      dto.sourceLongitude,
      dto.destinationLatitude,
      dto.destinationLongitude,
    ];
    const definedCount = values.filter((value) => value !== undefined).length;
    if (definedCount > 0 && definedCount < 4) {
      throw new BadRequestException(
        'Provide all four endpoint coordinates (sourceLatitude, sourceLongitude, destinationLatitude, destinationLongitude) or omit them all.',
      );
    }
  }

  private async buildRouteFieldsFromDto(dto: {
    source: string;
    destination: string;
    sourceLatitude?: number | null;
    sourceLongitude?: number | null;
    destinationLatitude?: number | null;
    destinationLongitude?: number | null;
    /** When true and coords are absent, resolve corridor via Google place names. */
    allowPlaceNameFallback?: boolean;
  }): Promise<{
    sourceLatitude: number | null;
    sourceLongitude: number | null;
    destinationLatitude: number | null;
    destinationLongitude: number | null;
    routePolyline: string | null;
    routeLengthMeters: number | null;
    routeBboxMinLat: number | null;
    routeBboxMaxLat: number | null;
    routeBboxMinLng: number | null;
    routeBboxMaxLng: number | null;
  }> {
    this.assertDtoEndpointCoordsAllOrNone({
      sourceLatitude:
        dto.sourceLatitude === null ? undefined : dto.sourceLatitude,
      sourceLongitude:
        dto.sourceLongitude === null ? undefined : dto.sourceLongitude,
      destinationLatitude:
        dto.destinationLatitude === null
          ? undefined
          : dto.destinationLatitude,
      destinationLongitude:
        dto.destinationLongitude === null
          ? undefined
          : dto.destinationLongitude,
    });

    const endpoints = {
      sourceLatitude: dto.sourceLatitude ?? null,
      sourceLongitude: dto.sourceLongitude ?? null,
      destinationLatitude: dto.destinationLatitude ?? null,
      destinationLongitude: dto.destinationLongitude ?? null,
    };

    const presentCount = [
      endpoints.sourceLatitude,
      endpoints.sourceLongitude,
      endpoints.destinationLatitude,
      endpoints.destinationLongitude,
    ].filter((value) => value !== null && value !== undefined).length;

    if (presentCount === 0 && dto.allowPlaceNameFallback !== false) {
      const fromPlaces =
        await this.rideDirectionsService.buildRouteGeometryFromPlaceNames(
          dto.source,
          dto.destination,
        );
      if (fromPlaces) {
        return {
          sourceLatitude: fromPlaces.source.latitude,
          sourceLongitude: fromPlaces.source.longitude,
          destinationLatitude: fromPlaces.destination.latitude,
          destinationLongitude: fromPlaces.destination.longitude,
          routePolyline: fromPlaces.polylineEncoded,
          routeLengthMeters: fromPlaces.lengthMeters,
          routeBboxMinLat: fromPlaces.bbox.minLat,
          routeBboxMaxLat: fromPlaces.bbox.maxLat,
          routeBboxMinLng: fromPlaces.bbox.minLng,
          routeBboxMaxLng: fromPlaces.bbox.maxLng,
        };
      }
    }

    return this.buildRouteFieldsFromEndpoints(endpoints);
  }

  /**
   * One-time corridor backfill for published rides that predate route storage
   * (or were published without coords / place-name Directions). Caps API usage.
   */
  private async backfillMissingRouteGeometryForSearch(
    dto: SearchRidesDto,
  ): Promise<void> {
    const qb = this.rideRepository
      .createQueryBuilder('ride')
      .where('ride.departure_date = :date', { date: dto.date })
      .andWhere('ride.route_polyline IS NULL');
    this.applyPassengerVisibilityFilter(qb);
    qb.orderBy('ride.created_at', 'ASC').take(20);

    if (dto.rideType !== undefined) {
      qb.andWhere('ride.ride_type = :rideType', { rideType: dto.rideType });
    }
    if (dto.seats !== undefined) {
      qb.andWhere('ride.available_seats >= :seats', { seats: dto.seats });
    }

    const rides = await qb.getMany();
    for (const ride of rides) {
      const fields = await this.buildRouteFieldsFromDto({
        source: ride.source,
        destination: ride.destination,
        sourceLatitude: ride.sourceLatitude ?? undefined,
        sourceLongitude: ride.sourceLongitude ?? undefined,
        destinationLatitude: ride.destinationLatitude ?? undefined,
        destinationLongitude: ride.destinationLongitude ?? undefined,
        allowPlaceNameFallback: true,
      });
      if (!fields.routePolyline) {
        continue;
      }
      Object.assign(ride, fields);
      await this.rideRepository.save(ride);
    }
  }

  private assertAssuredRouteGeometryForQueue(fields: {
    sourceLatitude?: number | null;
    sourceLongitude?: number | null;
    destinationLatitude?: number | null;
    destinationLongitude?: number | null;
    routePolyline?: string | null;
  }): void {
    if (fields.sourceLatitude == null || fields.sourceLongitude == null) {
      throw new BadRequestException(
        'Assured ride publishing requires source coordinates',
      );
    }
    if (
      fields.destinationLatitude == null ||
      fields.destinationLongitude == null
    ) {
      throw new BadRequestException(
        'Assured ride publishing requires destination coordinates',
      );
    }
    if (!fields.routePolyline?.trim()) {
      throw new BadRequestException(
        'Assured ride publishing requires resolvable route geometry. Check source and destination coordinates and try again.',
      );
    }
  }

  private async buildRouteFieldsFromEndpoints(endpoints: {
    sourceLatitude: number | null;
    sourceLongitude: number | null;
    destinationLatitude: number | null;
    destinationLongitude: number | null;
  }): Promise<{
    sourceLatitude: number | null;
    sourceLongitude: number | null;
    destinationLatitude: number | null;
    destinationLongitude: number | null;
    routePolyline: string | null;
    routeLengthMeters: number | null;
    routeBboxMinLat: number | null;
    routeBboxMaxLat: number | null;
    routeBboxMinLng: number | null;
    routeBboxMaxLng: number | null;
  }> {
    const empty = {
      sourceLatitude: null as number | null,
      sourceLongitude: null as number | null,
      destinationLatitude: null as number | null,
      destinationLongitude: null as number | null,
      routePolyline: null as string | null,
      routeLengthMeters: null as number | null,
      routeBboxMinLat: null as number | null,
      routeBboxMaxLat: null as number | null,
      routeBboxMinLng: null as number | null,
      routeBboxMaxLng: null as number | null,
    };

    const {
      sourceLatitude,
      sourceLongitude,
      destinationLatitude,
      destinationLongitude,
    } = endpoints;

    const presentCount = [
      sourceLatitude,
      sourceLongitude,
      destinationLatitude,
      destinationLongitude,
    ].filter((value) => value !== null && value !== undefined).length;

    if (presentCount === 0) {
      return empty;
    }

    if (presentCount < 4) {
      // Source/destination text changed without a full coordinate set — clear stale geometry.
      return empty;
    }

    const source: LatLng = {
      latitude: sourceLatitude!,
      longitude: sourceLongitude!,
    };
    const destination: LatLng = {
      latitude: destinationLatitude!,
      longitude: destinationLongitude!,
    };

    if (!isValidLatLng(source) || !isValidLatLng(destination)) {
      throw new BadRequestException('Invalid source or destination coordinates');
    }

    const geometry = await this.rideDirectionsService.buildRouteGeometry(
      source,
      destination,
    );

    if (!geometry) {
      return {
        sourceLatitude: source.latitude,
        sourceLongitude: source.longitude,
        destinationLatitude: destination.latitude,
        destinationLongitude: destination.longitude,
        routePolyline: null,
        routeLengthMeters: null,
        routeBboxMinLat: null,
        routeBboxMaxLat: null,
        routeBboxMinLng: null,
        routeBboxMaxLng: null,
      };
    }

    return {
      sourceLatitude: source.latitude,
      sourceLongitude: source.longitude,
      destinationLatitude: destination.latitude,
      destinationLongitude: destination.longitude,
      routePolyline: geometry.polylineEncoded,
      routeLengthMeters: geometry.lengthMeters,
      routeBboxMinLat: geometry.bbox.minLat,
      routeBboxMaxLat: geometry.bbox.maxLat,
      routeBboxMinLng: geometry.bbox.minLng,
      routeBboxMaxLng: geometry.bbox.maxLng,
    };
  }

  private toCivilDate(value: string | Date): string {
    if (value instanceof Date) {
      const year = value.getFullYear();
      const month = String(value.getMonth() + 1).padStart(2, '0');
      const day = String(value.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    return String(value).slice(0, 10);
  }

  private async sumActiveBookedSeats(
    manager: EntityManager,
    rideId: string,
  ): Promise<number> {
    const raw = await manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .select('COALESCE(SUM(booking.seats), 0)', 'booked')
      .where('booking.ride_id = :rideId', { rideId })
      .andWhere('booking.status IN (:...statuses)', {
        statuses: [BookingStatus.PENDING, BookingStatus.CONFIRMED],
      })
      .getRawOne<{ booked: string | number }>();

    return Number(raw?.booked ?? 0);
  }

  /**
   * Dedicated completion for trip-lifecycle rides (Regular + Assured).
   * Regular: IN_PROGRESS → COMPLETED after all passengers are picked up.
   * Assured: same trip gates, then releases ACTIVE deposit holds and
   * applies partial-fill compensation when applicable.
   */
  async complete(
    driverId: string,
    rideId: string,
  ): Promise<CompleteRideResponseDto> {
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const ride = await manager
          .getRepository(Ride)
          .createQueryBuilder('ride')
          .setLock('pessimistic_write')
          .where('ride.id = :rideId', { rideId })
          .getOne();

        if (!ride || ride.driverId !== driverId) {
          throw new NotFoundException('Ride not found');
        }

        if (ride.status === RideStatus.COMPLETED) {
          return this.buildCompleteResponse(manager, ride, true);
        }

        if (ride.status === RideStatus.CANCELLED) {
          throw new ConflictException('Cancelled rides cannot be completed');
        }

        if (ride.status === RideStatus.DRAFT) {
          throw new ConflictException('Draft rides cannot be completed');
        }

        if (ride.rideType === RideType.COMMUTE) {
          return this.completeCommuteRideInTransaction(manager, ride);
        }

        if (!supportsTripLifecycle(ride.rideType)) {
          throw new BadRequestException(
            `Ride type ${ride.rideType} cannot be completed via this endpoint`,
          );
        }

        if (ride.status !== RideStatus.IN_PROGRESS) {
          throw new ConflictException(
            'Rides must be started (IN_PROGRESS) before completion',
          );
        }

        const unpicked = await manager
          .getRepository(Booking)
          .createQueryBuilder('booking')
          .where('booking.ride_id = :rideId', { rideId: ride.id })
          .andWhere('booking.status IN (:...statuses)', {
            statuses: [BookingStatus.PENDING, BookingStatus.CONFIRMED],
          })
          .andWhere(
            '(booking.pickup_status IS NULL OR booking.pickup_status = :waiting)',
            { waiting: BookingPickupStatus.WAITING_FOR_PICKUP },
          )
          .getCount();
        if (unpicked > 0) {
          throw new ConflictException(
            'All confirmed passengers must be picked up before completing the ride',
          );
        }

        const activeBookings = await manager
          .getRepository(Booking)
          .createQueryBuilder('booking')
          .setLock('pessimistic_write')
          .where('booking.ride_id = :rideId', { rideId: ride.id })
          .andWhere('booking.status IN (:...statuses)', {
            statuses: [BookingStatus.PENDING, BookingStatus.CONFIRMED],
          })
          .orderBy('booking.id', 'ASC')
          .getMany();

        await this.fareSettlementService.settleRideFaresInTransaction(manager, {
          ride,
          driverId: ride.driverId,
          bookings: activeBookings,
        });

        let driverReleased: string | null = null;
        let ridersReleased = 0n;
        let riderCount = 0;

        if (ride.rideType === RideType.ASSURED) {
          const releasePlan = await this.collectAssuredReleaseTargets(
            manager,
            ride,
          );

          releasePlan.sort((a, b) => {
            const walletCmp = a.walletId.localeCompare(b.walletId);
            if (walletCmp !== 0) {
              return walletCmp;
            }
            return a.holdId.localeCompare(b.holdId);
          });

          for (const target of releasePlan) {
            const releaseResult =
              await this.walletService.releaseHoldInTransaction(manager, {
                holdId: target.holdId,
                idempotencyKey: `assured-deposit-release:${target.holdId}`,
              });
            const amount = BigInt(releaseResult.hold?.amount ?? target.amount);
            if (target.role === 'driver') {
              driverReleased = amount.toString();
            } else {
              ridersReleased += amount;
              riderCount += 1;
            }
          }
        }

        await manager
          .getRepository(Booking)
          .createQueryBuilder()
          .update(Booking)
          .set({ status: BookingStatus.COMPLETED })
          .where('ride_id = :rideId', { rideId: ride.id })
          .andWhere('status IN (:...statuses)', {
            statuses: [BookingStatus.PENDING, BookingStatus.CONFIRMED],
          })
          .execute();

        if (ride.rideType === RideType.ASSURED) {
          await this.assuredLifecycleService.payPartialFillIfApplicable(
            manager,
            ride,
            ride.availableSeats,
            'completion',
          );
          await this.assuredLifecycleService.clearPassengerDepositPenaltiesOnRideComplete(
            manager,
            ride.id,
          );
        }

        ride.status = RideStatus.COMPLETED;
        await manager.getRepository(Ride).save(ride);

        if (ride.rideType === RideType.ASSURED) {
          return {
            rideId: ride.id,
            status: RideStatus.COMPLETED,
            rideType: ride.rideType,
            releasedDeposits: {
              driver: driverReleased,
              riders: ridersReleased.toString(),
              riderCount,
            },
            alreadyCompleted: false,
          };
        }

        return {
          rideId: ride.id,
          status: RideStatus.COMPLETED,
          rideType: ride.rideType,
          alreadyCompleted: false,
        };
      });

      if (supportsTripLifecycle(result.rideType)) {
        await this.trackingService.clearRideTracking(rideId, 'complete');
      }

      return result;
    } catch (error) {
      if (
        error instanceof WalletHoldAlreadyConsumedError ||
        error instanceof WalletHoldNotActiveError ||
        error instanceof InsufficientWalletBalanceError ||
        error instanceof ConflictException ||
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      throw error;
    }
  }

  private async completeCommuteRideInTransaction(
    manager: EntityManager,
    ride: Ride,
  ): Promise<CompleteRideResponseDto> {
    if (
      ride.status !== RideStatus.PUBLISHED &&
      ride.status !== RideStatus.IN_PROGRESS
    ) {
      throw new ConflictException(
        'Commute rides must be PUBLISHED or IN_PROGRESS before completion',
      );
    }

    const confirmedBookings = await manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .setLock('pessimistic_write')
      .where('booking.ride_id = :rideId', { rideId: ride.id })
      .andWhere('booking.booking_mode = :mode', { mode: BookingMode.COMMUTE })
      .andWhere('booking.status = :status', {
        status: BookingStatus.CONFIRMED,
      })
      .orderBy('booking.id', 'ASC')
      .getMany();

    const commuteSettlement =
      await this.commuteSettlementService.settleCommuteRideInTransaction(
        manager,
        {
          ride,
          driverId: ride.driverId,
          bookings: confirmedBookings,
        },
      );

    if (confirmedBookings.length > 0) {
      await manager
        .getRepository(Booking)
        .createQueryBuilder()
        .update(Booking)
        .set({ status: BookingStatus.COMPLETED })
        .where('ride_id = :rideId', { rideId: ride.id })
        .andWhere('booking_mode = :mode', { mode: BookingMode.COMMUTE })
        .andWhere('status = :status', { status: BookingStatus.CONFIRMED })
        .execute();
    }

    ride.status = RideStatus.COMPLETED;
    await manager.getRepository(Ride).save(ride);

    return {
      rideId: ride.id,
      status: RideStatus.COMPLETED,
      rideType: ride.rideType,
      alreadyCompleted: false,
      commuteSettlement,
    };
  }

  private async collectAssuredReleaseTargets(
    manager: EntityManager,
    ride: Ride,
  ): Promise<
    Array<{
      holdId: string;
      walletId: string;
      amount: string;
      role: 'driver' | 'rider';
    }>
  > {
    const targets: Array<{
      holdId: string;
      walletId: string;
      amount: string;
      role: 'driver' | 'rider';
    }> = [];

    if (ride.driverDepositHoldId) {
      const driverHold = await manager.getRepository(WalletHold).findOne({
        where: { id: ride.driverDepositHoldId },
      });
      if (driverHold) {
        if (
          driverHold.status === WalletHoldStatus.ACTIVE ||
          driverHold.status === WalletHoldStatus.RELEASED
        ) {
          targets.push({
            holdId: driverHold.id,
            walletId: driverHold.walletId,
            amount: driverHold.amount,
            role: 'driver',
          });
        } else {
          throw new ConflictException(
            `Driver Assured deposit hold cannot be released (status=${driverHold.status})`,
          );
        }
      }
    }

    const eligibleBookings = await manager.getRepository(Booking).find({
      where: {
        rideId: ride.id,
        status: In([BookingStatus.PENDING, BookingStatus.CONFIRMED]),
      },
    });

    for (const booking of eligibleBookings) {
      if (!booking.walletHoldId) {
        continue;
      }
      const riderHold = await manager.getRepository(WalletHold).findOne({
        where: { id: booking.walletHoldId },
      });
      if (!riderHold) {
        continue;
      }
      if (
        riderHold.status === WalletHoldStatus.ACTIVE ||
        riderHold.status === WalletHoldStatus.RELEASED
      ) {
        targets.push({
          holdId: riderHold.id,
          walletId: riderHold.walletId,
          amount: riderHold.amount,
          role: 'rider',
        });
      } else {
        throw new ConflictException(
          `Rider Assured deposit hold cannot be released (status=${riderHold.status})`,
        );
      }
    }

    return targets;
  }

  private async buildCompleteResponse(
    manager: EntityManager,
    ride: Ride,
    alreadyCompleted: boolean,
  ): Promise<CompleteRideResponseDto> {
    if (ride.rideType === RideType.COMMUTE) {
      return this.buildCommuteCompleteResponse(manager, ride, alreadyCompleted);
    }

    if (ride.rideType !== RideType.ASSURED) {
      return {
        rideId: ride.id,
        status: RideStatus.COMPLETED,
        rideType: ride.rideType,
        alreadyCompleted,
      };
    }

    let driver: string | null = ride.assuredDepositAmount;
    if (ride.driverDepositHoldId) {
      const hold = await manager.getRepository(WalletHold).findOne({
        where: { id: ride.driverDepositHoldId },
      });
      if (hold) {
        driver = hold.amount;
      }
    }

    const completedBookings = await manager.getRepository(Booking).find({
      where: {
        rideId: ride.id,
        status: BookingStatus.COMPLETED,
      },
    });

    let riders = 0n;
    let riderCount = 0;
    for (const booking of completedBookings) {
      if (booking.assuredDepositAmount) {
        riders += BigInt(booking.assuredDepositAmount);
        riderCount += 1;
      }
    }

    return {
      rideId: ride.id,
      status: RideStatus.COMPLETED,
      rideType: ride.rideType,
      releasedDeposits: {
        driver,
        riders: riders.toString(),
        riderCount,
      },
      alreadyCompleted,
    };
  }

  private async buildCommuteCompleteResponse(
    manager: EntityManager,
    ride: Ride,
    alreadyCompleted: boolean,
  ): Promise<CompleteRideResponseDto> {
    const settledBookings = await manager.getRepository(Booking).find({
      where: {
        rideId: ride.id,
        bookingMode: BookingMode.COMMUTE,
        status: BookingStatus.COMPLETED,
      },
      order: { id: 'ASC' },
    });

    let driverSettlementTotal = 0n;
    let platformMarginTotal = 0n;
    let settledBookingCount = 0;

    for (const booking of settledBookings) {
      if (!booking.settledAt) {
        continue;
      }
      settledBookingCount += 1;
      if (booking.driverShareAmount) {
        driverSettlementTotal += BigInt(booking.driverShareAmount);
      }
      if (booking.platformShareAmount) {
        platformMarginTotal += BigInt(booking.platformShareAmount);
      }
    }

    return {
      rideId: ride.id,
      status: RideStatus.COMPLETED,
      rideType: ride.rideType,
      alreadyCompleted,
      commuteSettlement: {
        settledBookingCount,
        driverSettlementTotal: driverSettlementTotal.toString(),
        platformMarginTotal: platformMarginTotal.toString(),
      },
    };
  }

  private async toSearchItems(
    rides: Ride[],
    routeMatch?: CommuteSearchRouteMatchContext,
  ): Promise<RideSearchItemDto[]> {
    if (rides.length === 0) {
      return [];
    }

    const driverIds = [...new Set(rides.map((ride) => ride.driverId))];
    const vehicleIds = [...new Set(rides.map((ride) => ride.vehicleId))];

    const [profiles, vehicles] = await Promise.all([
      this.userProfileRepository.find({
        where: { userId: In(driverIds) },
      }),
      this.vehicleRepository.find({
        where: { id: In(vehicleIds) },
        withDeleted: true,
      }),
    ]);

    const profileByUserId = new Map(
      profiles.map((profile) => [profile.userId, profile] as const),
    );
    const vehicleById = new Map(
      vehicles.map((vehicle) => [vehicle.id, vehicle] as const),
    );

    return rides.map((ride) => {
      const profile = profileByUserId.get(ride.driverId);
      const vehicle = vehicleById.get(ride.vehicleId);

      if (!vehicle) {
        throw new NotFoundException('Ride vehicle not found');
      }

      const routeMatchPercentage = this.resolveCommuteRouteMatchPercentage(
        ride,
        routeMatch,
      );

      return {
        id: ride.id,
        rideType: ride.rideType,
        status: ride.status,
        source: ride.source,
        destination: ride.destination,
        departureDate: ride.departureDate,
        departureTime: this.formatTime(ride.departureTime),
        availableSeats: ride.availableSeats,
        totalSeats: ride.totalSeats,
        pricePerSeat: ride.pricePerSeat,
        ...(ride.rideType === RideType.COMMUTE
          ? {
              riderPricePerSeat: computeCommuteRiderPricePerSeat(
                ride.pricePerSeat,
              ),
              ...(routeMatchPercentage !== undefined
                ? { routeMatchPercentage }
                : {}),
            }
          : {}),
        preferences: {
          maxTwoInBackSeat: ride.maxTwoInBackSeat,
          noSmoking: ride.noSmoking,
          noPets: ride.noPets,
          luggageAllowed: ride.luggageAllowed,
        },
        notes: ride.notes,
        assuredDepositPercentage:
          ride.rideType === RideType.ASSURED
            ? ride.assuredDepositPercentage
            : null,
        assuredDepositAmount:
          ride.rideType === RideType.ASSURED
            ? ride.assuredDepositAmount
            : null,
        driver: {
          id: ride.driverId,
          displayName: profile?.displayName ?? profile?.firstName ?? null,
          profilePhoto: profile?.profilePhoto ?? null,
        },
        vehicle: {
          id: vehicle.id,
          vehicleType: vehicle.vehicleType,
          make: vehicle.make,
          model: vehicle.model,
          variant: vehicle.variant,
          color: vehicle.color,
          seatingCapacity: vehicle.seatingCapacity,
        },
      };
    });
  }

  private async lockWalletForUpdate(
    manager: EntityManager,
    userId: string,
  ): Promise<Wallet> {
    const wallet = await manager
      .getRepository(Wallet)
      .createQueryBuilder('wallet')
      .setLock('pessimistic_write')
      .where('wallet.user_id = :userId', { userId })
      .getOne();

    if (!wallet) {
      throw new WalletNotFoundError();
    }

    return wallet;
  }

  private assertWalletAllowsDeposit(wallet: Wallet): void {
    if (wallet.status === WalletStatus.SUSPENDED) {
      throw new ForbiddenException('Wallet is suspended');
    }
    if (wallet.status === WalletStatus.LOCKED) {
      throw new ForbiddenException('Wallet is locked');
    }
  }

  private async assertDriverCanPublish(
    driverId: string,
    vehicleId: string,
  ): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id: driverId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('User status does not allow publishing rides');
    }

    const eligibility = await this.verificationService.canPublishRide(
      driverId,
      vehicleId,
    );

    if (!eligibility.allowed) {
      if (eligibility.vehicleEligible === false) {
        throw new ForbiddenException(
          'Selected vehicle is not eligible for publishing (must exist, belong to you, be active, and not deleted)',
        );
      }

      const labels = eligibility.missing
        .map((type) => {
          if (type === VerificationType.IDENTITY) return 'identity';
          if (type === VerificationType.DRIVING_LICENSE) return 'driving license';
          return 'vehicle';
        })
        .join(', ');

      throw new ForbiddenException(
        `Missing required verification to publish a ride: ${labels}`,
      );
    }
  }

  private async requireOwnedRide(
    driverId: string,
    rideId: string,
  ): Promise<Ride> {
    const ride = await this.rideRepository.findOne({
      where: { id: rideId, driverId },
    });
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }
    return ride;
  }

  private normalizeTime(value: string): string {
    const parts = value.split(':');
    if (parts.length === 2) {
      return `${value}:00`;
    }
    return value;
  }

  private async toHistoryListItems(
    rides: Ride[],
  ): Promise<RideHistoryListItemDto[]> {
    if (rides.length === 0) {
      return [];
    }

    const rideIds = rides.map((ride) => ride.id);
    const vehicleIds = [...new Set(rides.map((ride) => ride.vehicleId))];

    const [bookings, vehicles] = await Promise.all([
      this.bookingRepository.find({
        where: { rideId: In(rideIds) },
        select: {
          id: true,
          rideId: true,
          seats: true,
          status: true,
          totalAmount: true,
        },
      }),
      this.vehicleRepository.find({
        where: { id: In(vehicleIds) },
        withDeleted: true,
      }),
    ]);

    const bookingsByRideId = new Map<string, Booking[]>();
    for (const booking of bookings) {
      const list = bookingsByRideId.get(booking.rideId) ?? [];
      list.push(booking);
      bookingsByRideId.set(booking.rideId, list);
    }

    const vehicleById = new Map(
      vehicles.map((vehicle) => [vehicle.id, vehicle] as const),
    );
    const vehicleOwnerIds = [
      ...new Set(vehicles.map((vehicle) => vehicle.userId)),
    ];
    const vehicleVerifiedByUserId =
      await this.resolveVerificationFlags(
        vehicleOwnerIds,
        VerificationType.VEHICLE,
      );

    return rides.map((ride) => {
      const rideBookings = bookingsByRideId.get(ride.id) ?? [];
      const bookedSeats = rideBookings
        .filter((booking) =>
          [
            BookingStatus.PENDING,
            BookingStatus.CONFIRMED,
            BookingStatus.COMPLETED,
          ].includes(booking.status),
        )
        .reduce((sum, booking) => sum + booking.seats, 0);
      const vehicle = vehicleById.get(ride.vehicleId) ?? null;

      return {
        ride: this.toHistoryTrip(ride, bookedSeats),
        vehicle: vehicle
          ? this.toHistoryVehicle(
              vehicle,
              vehicleVerifiedByUserId.get(vehicle.userId) === true,
            )
          : null,
        earnings: this.calculateHistoryEarnings(rideBookings),
        passengerCount: rideBookings.length,
      };
    });
  }

  private toHistoryTrip(ride: Ride, bookedSeats: number): RideHistoryTripDto {
    return {
      id: ride.id,
      status: ride.status,
      rideType: ride.rideType,
      source: ride.source,
      destination: ride.destination,
      sourceLatitude: null,
      sourceLongitude: null,
      destinationLatitude: null,
      destinationLongitude: null,
      departureDate: this.toCivilDate(ride.departureDate),
      departureTime: this.formatTime(ride.departureTime),
      startedAt: null,
      completedAt: null,
      cancelledAt: ride.cancelledAt?.toISOString() ?? null,
      durationMinutes: null,
      distanceKm: null,
      totalSeats: ride.totalSeats,
      bookedSeats,
      pricePerSeat: ride.pricePerSeat,
    };
  }

  private toHistoryVehicle(
    vehicle: Vehicle,
    isVerified: boolean,
  ): RideHistoryVehicleDto {
    return {
      id: vehicle.id,
      name: `${vehicle.make} ${vehicle.model}`.trim(),
      make: vehicle.make,
      model: vehicle.model,
      color: vehicle.color,
      registrationNumber: vehicle.registrationNumber,
      isVerified,
    };
  }

  private calculateHistoryEarnings(
    bookings: Array<Pick<Booking, 'status' | 'totalAmount'>>,
  ): RideHistoryEarningsDto {
    const passengerTotal = bookings
      .filter((booking) => booking.status === BookingStatus.COMPLETED)
      .reduce((sum, booking) => sum + BigInt(booking.totalAmount), 0n);

    return {
      passengerTotal: passengerTotal.toString(),
      assuredBonus: null,
      otherEarnings: null,
      total: passengerTotal.toString(),
    };
  }

  private async resolveVerificationFlags(
    userIds: string[],
    type: VerificationType,
  ): Promise<Map<string, boolean>> {
    const uniqueIds = [...new Set(userIds.filter(Boolean))];
    const result = new Map<string, boolean>();
    if (uniqueIds.length === 0) {
      return result;
    }

    const rows = await this.verificationRepository.find({
      where: {
        userId: In(uniqueIds),
        verificationType: type,
        isCurrent: true,
      },
    });

    for (const userId of uniqueIds) {
      result.set(userId, false);
    }
    for (const row of rows) {
      result.set(row.userId, this.isIdentityCurrentlyVerified(row));
    }
    return result;
  }

  private async isVerificationCurrentlyVerified(
    userId: string,
    type: VerificationType,
  ): Promise<boolean> {
    const record = await this.verificationRepository.findOne({
      where: {
        userId,
        verificationType: type,
        isCurrent: true,
      },
    });
    return this.isIdentityCurrentlyVerified(record ?? undefined);
  }

  private isIdentityCurrentlyVerified(
    record: UserVerification | undefined,
  ): boolean {
    if (!record || record.status !== VerificationStatus.VERIFIED) {
      return false;
    }
    if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
      return false;
    }
    return true;
  }

  private toResponse(ride: Ride): RideResponseDto {
    const isAssured = ride.rideType === RideType.ASSURED;
    const isCommute = ride.rideType === RideType.COMMUTE;
    const isBookable = isAssured
      ? isAssuredBookableStatus(ride.status) && ride.availableSeats > 0
      : isCommute
        ? isCommutePublishedStatus(ride.status) && ride.availableSeats > 0
        : isRegularPublishedStatus(ride.status) && ride.availableSeats > 0;

    return {
      id: ride.id,
      driverId: ride.driverId,
      vehicleId: ride.vehicleId,
      rideType: ride.rideType,
      status: ride.status,
      source: ride.source,
      destination: ride.destination,
      departureDate: this.toCivilDate(ride.departureDate),
      departureTime: this.formatTime(ride.departureTime),
      totalSeats: ride.totalSeats,
      availableSeats: ride.availableSeats,
      pricePerSeat: ride.pricePerSeat,
      ...(isCommute
        ? {
            riderPricePerSeat: computeCommuteRiderPricePerSeat(
              ride.pricePerSeat,
            ),
          }
        : {}),
      maxTwoInBackSeat: ride.maxTwoInBackSeat,
      noSmoking: ride.noSmoking,
      noPets: ride.noPets,
      luggageAllowed: ride.luggageAllowed,
      notes: ride.notes,
      assuredDepositPercentage: ride.assuredDepositPercentage,
      assuredDepositAmount: ride.assuredDepositAmount,
      regularSeatsPolicy: ride.regularSeatsPolicy,
      assuranceWindowStart: isAssured
        ? ride.assuranceWindowStart
          ? this.formatTime(ride.assuranceWindowStart)
          : null
        : null,
      assuranceWindowEnd: isAssured
        ? ride.assuranceWindowEnd
          ? this.formatTime(ride.assuranceWindowEnd)
          : null
        : null,
      isBookable,
      createdAt: ride.createdAt.toISOString(),
      updatedAt: ride.updatedAt.toISOString(),
    };
  }

  private formatTime(value: string): string {
    return value.length >= 8 ? value.slice(0, 8) : value;
  }
}
