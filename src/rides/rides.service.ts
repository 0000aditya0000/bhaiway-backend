import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
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
  ActiveAssuredRideExistsError,
  CommuteScheduleConflictError,
} from './errors/ride-publishing.errors';
import {
  ACTIVE_ASSURED_RIDE_STATUSES,
  assertDepartureIsInFuture,
} from './ride-publishing.rules';
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
import { RegularRideCancellationService } from './regular-ride-cancellation.service';
import { NoShowClaimResponseDto } from '../no-show/dto/no-show-claim-response.dto';
import { NoShowClaimsService } from '../no-show/no-show-claims.service';
import { commuteRideCancelRefundKey } from '../bookings/commute-cancellation.math';
import { CommuteCancellationService } from '../bookings/commute-cancellation.service';
import {
  CommuteSettlementService,
  type CommuteRideSettlementSummary,
} from '../fare/commute-settlement.service';
import { FareSettlementService } from '../fare/fare-settlement.service';
import { RatingsService } from '../ratings/ratings.service';
import { ChatService } from '../chat/chat.service';
import { CommuteRewardProgressService } from '../commute-rewards/commute-reward-progress.service';
import { CouponIssuanceService } from '../coupons/coupon-issuance.service';
import { CouponRedemptionService } from '../coupons/coupon-redemption.service';
import { CouponRedemption } from '../coupons/entities/coupon-redemption.entity';
import {
  CouponActorContext,
  CouponBenefitType,
  CouponChargeScope,
  CouponRideTypeScope,
  CouponTransactionContext,
  normalizeCouponCode,
} from '../coupons/enums/coupon.enums';
import { NotificationsService } from '../notifications/notifications.service';
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
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity';
import { Wallet, WalletStatus } from '../wallet/entities/wallet.entity';
import { WalletService } from '../wallet/wallet.service';
import { InvoicesService } from '../invoices/invoices.service';
import {
  ActiveRideItemDto,
  ActiveRideRole,
  ActiveRidesResponseDto,
} from './dto/active-ride-response.dto';
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
import { RideSeries } from './entities/ride-series.entity';
import { Ride } from './entities/ride.entity';
import {
  RegularSeatsPolicy,
  RideCancellationReason,
  RideDirection,
  RideSeriesStatus,
  RideStatus,
  RideType,
  SeriesScope,
} from './enums/ride.enums';
import { isCommuteSeriesPublish } from './commute-recurrence';
import {
  CommuteRideSeriesService,
  isPastOccurrence,
} from './commute-ride-series.service';
import { isAtOrAfterDeparture } from '../assured/assured-timing';
import {
  currentCivilClock,
  toCivilDateString,
} from '../common/time/ride-timezone';
import { supportsTripLifecycle } from './ride-trip-lifecycle';
import { computeCommuteRiderPricePerSeat } from './commute-fare.math';
import { computeCommuteRouteMatchPercentage } from './commute-route-match.math';
import { RideDirectionsService } from './route/ride-directions.service';
import { RouteSelectionService } from './route/route-selection.service';
import {
  decodePolyline,
  isValidLatLng,
  LatLng,
  matchesSelectedDriverRoute,
  SOURCE_CATCHMENT_METERS,
} from './route/route-geometry';
import {
  RequestRouteOptionsDto,
  RouteOptionsResponseDto,
} from './dto/route-options.dto';

interface CommuteSearchRouteMatchContext {
  pickup: LatLng;
  dropoff: LatLng;
}

@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);

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
    private readonly commuteCancellationService: CommuteCancellationService,
    private readonly bookingsService: BookingsService,
    private readonly trackingService: TrackingService,
    private readonly rideDirectionsService: RideDirectionsService,
    private readonly routeSelectionService: RouteSelectionService,
    private readonly ratingsService: RatingsService,
    private readonly chatService: ChatService,
    private readonly notificationsService: NotificationsService,
    private readonly couponIssuanceService: CouponIssuanceService,
    private readonly couponRedemptionService: CouponRedemptionService,
    private readonly commuteRewardProgressService: CommuteRewardProgressService,
    private readonly regularRideCancellationService: RegularRideCancellationService,
    private readonly noShowClaimsService: NoShowClaimsService,
    private readonly invoicesService: InvoicesService,
    private readonly commuteRideSeriesService: CommuteRideSeriesService,
  ) {}

  async cancelByDriver(
    driverId: string,
    rideId: string,
    seriesScope: SeriesScope = SeriesScope.THIS_OCCURRENCE,
  ): Promise<AssuredRideLifecycleResponseDto> {
    const ride = await this.rideRepository.findOne({
      where: { id: rideId },
      select: {
        id: true,
        driverId: true,
        rideType: true,
        seriesId: true,
      },
    });

    if (!ride || ride.driverId !== driverId) {
      throw new NotFoundException('Ride not found');
    }

    if (
      seriesScope === SeriesScope.THIS_AND_FUTURE &&
      (ride.rideType !== RideType.COMMUTE || !ride.seriesId)
    ) {
      throw new BadRequestException(
        'seriesScope=THIS_AND_FUTURE is only valid for Daily Office Commute series occurrences',
      );
    }

    if (ride.rideType === RideType.REGULAR) {
      return this.cancelRegularRideByDriver(driverId, rideId);
    }

    if (ride.rideType === RideType.ASSURED) {
      return this.assuredLifecycleService.cancelRideByDriver(driverId, rideId);
    }

    if (ride.rideType === RideType.COMMUTE) {
      if (
        seriesScope === SeriesScope.THIS_AND_FUTURE &&
        ride.seriesId
      ) {
        return this.cancelCommuteSeriesByDriver(driverId, rideId);
      }
      const result = await this.commuteCancellationService.cancelRideByDriver(
        driverId,
        rideId,
      );
      await this.trackingService.clearRideTracking(rideId, 'cancel');
      return result;
    }

    throw new BadRequestException(`Unsupported ride type: ${ride.rideType}`);
  }

  /**
   * Start a trip-lifecycle ride (Regular, Assured, or Commute): PUBLISHED → IN_PROGRESS.
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
      return this.regularRideCancellationService.cancelRideInTransaction(
        manager,
        {
          rideId,
          cancelledByUserId: driverId,
          requireDriverOwnership: true,
          rideCancellationReason: RideCancellationReason.DRIVER_CANCELLED,
          bookingCancellationReason: BookingCancellationReason.RIDE_CANCELLED,
        },
      );
    });

    await this.trackingService.clearRideTracking(rideId, 'cancel');
    await this.chatService.safeCloseForRide(rideId);
    for (const booking of result.cancelledBookings ?? []) {
      await this.notificationsService.safeNotifyBookingCancelled({
        bookingId: booking.bookingId,
        rideId,
        recipientUserId: booking.passengerId,
        bookingMode: 'REGULAR',
        cancelledBy: 'driver',
        cancellationReason: 'RIDE_CANCELLED',
      });
    }
    const { cancelledBookings: _c, ...response } = result;
    return response;
  }

  private async cancelCommuteSeriesByDriver(
    driverId: string,
    rideId: string,
  ): Promise<AssuredRideLifecycleResponseDto> {
    const outcome = await this.dataSource.transaction(async (manager) => {
      const ride = await manager
        .getRepository(Ride)
        .createQueryBuilder('ride')
        .setLock('pessimistic_write')
        .where('ride.id = :rideId', { rideId })
        .getOne();
      if (!ride || ride.driverId !== driverId) {
        throw new NotFoundException('Ride not found');
      }

      // In-progress trips cannot be driver-cancelled. Abort before touching
      // siblings so THIS_AND_FUTURE never partially cancels later dates.
      if (ride.status === RideStatus.IN_PROGRESS) {
        throw new ConflictException({
          statusCode: 409,
          code: 'COMMUTE_SERIES_OCCURRENCE_IN_PROGRESS',
          message:
            'The selected occurrence is in progress. Series cancellation does not cancel in-progress or sibling occurrences. Complete the trip, or cancel remaining dates after this ride is no longer in progress.',
          error: 'Conflict',
        });
      }

      const targets = await this.commuteRideSeriesService.findSeriesDateScope(
        manager,
        ride,
        SeriesScope.THIS_AND_FUTURE,
      );

      const cancelledRideIds: string[] = [];
      const skippedBookedRideIds: string[] = [];
      const skippedIneligibleRideIds: string[] = [];
      const notify: Array<{ bookingId: string; passengerId: string; rideId: string }> =
        [];
      let fareRefundedTotal = 0n;
      let cancelledBookingCount = 0;
      let selectedResponse: AssuredRideLifecycleResponseDto | null = null;

      for (const target of targets) {
        const isSelected = target.id === ride.id;
        if (
          target.status === RideStatus.COMPLETED ||
          target.status === RideStatus.CANCELLED ||
          target.status === RideStatus.IN_PROGRESS
        ) {
          if (!isSelected) {
            skippedIneligibleRideIds.push(target.id);
          }
          if (isSelected && target.status === RideStatus.CANCELLED) {
            const selectedCancel =
              await this.commuteCancellationService.cancelRideInTransaction(
                manager,
                {
                  rideId: target.id,
                  cancelledByUserId: driverId,
                  requireDriverOwnership: true,
                  rideCancellationReason: RideCancellationReason.DRIVER_CANCELLED,
                  bookingCancellationReason:
                    BookingCancellationReason.RIDE_CANCELLED,
                  refundKeyForBooking: commuteRideCancelRefundKey,
                },
              );
            selectedResponse = selectedCancel.response;
            for (const item of selectedCancel.cancelledForNotify) {
              notify.push({ ...item, rideId: target.id });
            }
          }
          continue;
        }

        if (!isSelected) {
          const bookedSeats = await this.sumActiveBookedSeats(
            manager,
            target.id,
          );
          if (bookedSeats > 0) {
            skippedBookedRideIds.push(target.id);
            continue;
          }
        }

        const cancelled =
          await this.commuteCancellationService.cancelRideInTransaction(
            manager,
            {
              rideId: target.id,
              cancelledByUserId: driverId,
              requireDriverOwnership: true,
              rideCancellationReason: RideCancellationReason.DRIVER_CANCELLED,
              bookingCancellationReason: BookingCancellationReason.RIDE_CANCELLED,
              refundKeyForBooking: commuteRideCancelRefundKey,
            },
          );
        cancelledRideIds.push(target.id);
        cancelledBookingCount += cancelled.response.cancelledBookingCount;
        fareRefundedTotal += BigInt(cancelled.response.fareRefundedTotal);
        for (const item of cancelled.cancelledForNotify) {
          notify.push({ ...item, rideId: target.id });
        }
        if (isSelected) {
          selectedResponse = cancelled.response;
        }
      }

      if (ride.seriesId) {
        const remaining = await manager
          .getRepository(Ride)
          .createQueryBuilder('ride')
          .where('ride.series_id = :seriesId', { seriesId: ride.seriesId })
          .andWhere('ride.status NOT IN (:...terminal)', {
            terminal: [RideStatus.CANCELLED, RideStatus.COMPLETED],
          })
          .getCount();
        if (remaining === 0) {
          await manager.getRepository(RideSeries).update(
            { id: ride.seriesId },
            { status: RideSeriesStatus.CANCELLED },
          );
        }
      }

      if (!selectedResponse) {
        throw new ConflictException(
          'No eligible occurrences in this series could be cancelled',
        );
      }

      return {
        response: {
          ...selectedResponse,
          cancelledBookingCount,
          fareRefundedTotal: fareRefundedTotal.toString(),
          cancelledRideIds,
          skippedBookedRideIds,
          skippedIneligibleRideIds,
        },
        notify,
        cancelledRideIds,
      };
    });

    for (const id of outcome.cancelledRideIds) {
      await this.trackingService.clearRideTracking(id, 'cancel');
      await this.chatService.safeCloseForRide(id);
    }
    for (const item of outcome.notify) {
      await this.notificationsService.safeNotifyCommuteCancelled({
        bookingId: item.bookingId,
        rideId: item.rideId,
        recipientUserId: item.passengerId,
        cancelledBy: 'driver',
        cancellationReason: 'RIDE_CANCELLED',
      });
    }
    return outcome.response;
  }

  async reportDriverNoShow(
    passengerId: string,
    rideId: string,
  ): Promise<NoShowClaimResponseDto> {
    return this.noShowClaimsService.reportDriverDidNotCome(passengerId, rideId);
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
    this.assertCommuteSeriesFieldsForRideType(dto);
    if (dto.couponCode?.trim() && dto.rideType !== RideType.ASSURED) {
      throw new BadRequestException(
        'Coupons can only be applied to the Assured Ride driver security deposit',
      );
    }
    await this.assertDriverCanPublish(driverId, dto.vehicleId);

    assertDepartureIsInFuture(
      dto.departureDate,
      this.normalizeTime(dto.departureTime),
    );

    if (dto.rideType === RideType.ASSURED) {
      return this.createAssuredRide(driverId, dto, options?.idempotencyKey);
    }

    if (dto.rideType === RideType.COMMUTE) {
      if (isCommuteSeriesPublish(dto)) {
        const result = await this.commuteRideSeriesService.publish(
          driverId,
          dto,
          options?.idempotencyKey,
        );
        return this.toResponse(result.original, {
          series: result.series,
          occurrences: result.occurrences,
        });
      }
      return this.createCommuteRide(driverId, dto, options?.idempotencyKey);
    }

    return this.createRegularRide(driverId, dto);
  }

  async listRouteOptions(
    dto: RequestRouteOptionsDto,
  ): Promise<RouteOptionsResponseDto> {
    const source: LatLng = {
      latitude: dto.sourceLatitude,
      longitude: dto.sourceLongitude,
    };
    const destination: LatLng = {
      latitude: dto.destinationLatitude,
      longitude: dto.destinationLongitude,
    };
    if (!isValidLatLng(source) || !isValidLatLng(destination)) {
      throw new BadRequestException('Invalid source or destination coordinates');
    }
    const raw = await this.rideDirectionsService.listDrivingRouteOptions(
      source,
      destination,
    );
    const signed = this.routeSelectionService.signOptions(raw);
    return {
      options: signed.map((option) => ({
        selectionToken: option.selectionToken,
        optionId: option.optionId,
        polyline: option.polylineEncoded,
        distanceMeters: option.lengthMeters,
        durationSeconds: option.durationSeconds,
        sourceLatitude: option.source.latitude,
        sourceLongitude: option.source.longitude,
        destinationLatitude: option.destination.latitude,
        destinationLongitude: option.destination.longitude,
      })),
    };
  }

  private resolveDtoSelectedRoute(dto: {
    routeSelectionToken?: string;
    sourceLatitude?: number;
    sourceLongitude?: number;
    destinationLatitude?: number;
    destinationLongitude?: number;
  }) {
    return this.routeSelectionService.resolveSelectedRoute({
      token: dto.routeSelectionToken,
      sourceLatitude: dto.sourceLatitude,
      sourceLongitude: dto.sourceLongitude,
      destinationLatitude: dto.destinationLatitude,
      destinationLongitude: dto.destinationLongitude,
    });
  }

  private async createRegularRide(
    driverId: string,
    dto: CreateRideDto,
  ): Promise<RideResponseDto> {
    const routeFields = this.resolveDtoSelectedRoute(dto);

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
      womenOnly: dto.womenOnly === true,
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
    idempotencyKey?: string | null,
  ): Promise<RideResponseDto> {
    const clientKey = idempotencyKey?.trim() || null;
    if (clientKey && clientKey.length > 255) {
      throw new BadRequestException(
        'Idempotency-Key must be at most 255 characters',
      );
    }

    if (clientKey) {
      const existing = await this.rideRepository.findOne({
        where: { publishIdempotencyKey: clientKey },
      });
      if (existing) {
        this.assertCommutePublishIdempotentMatches(existing, driverId, dto);
        return this.toResponse(existing);
      }
    }

    const routeFields = this.resolveDtoSelectedRoute(dto);

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
      womenOnly: false,
      notes: dto.notes?.trim() ?? null,
      assuredDepositPercentage: null,
      assuredDepositAmount: null,
      driverDepositHoldId: null,
      publishIdempotencyKey: clientKey,
      seriesId: null,
      occurrenceDate: null,
      direction: null,
      ...routeFields,
    });

    try {
      const saved = await this.rideRepository.save(ride);
      return this.toResponse(saved);
    } catch (error) {
      if (clientKey && this.isAssuredPublishIdempotencyUniqueViolation(error)) {
        const recovered = await this.rideRepository.findOne({
          where: { publishIdempotencyKey: clientKey },
        });
        if (recovered) {
          this.assertCommutePublishIdempotentMatches(recovered, driverId, dto);
          return this.toResponse(recovered);
        }
      }
      if (this.isCommuteSlotUniqueViolation(error)) {
        throw new CommuteScheduleConflictError();
      }
      throw error;
    }
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
        await this.assertAssuredPublishIdempotentMatches(
          existing,
          driverId,
          dto,
        );
        return this.toResponse(existing);
      }
    }

    this.assertAssuredPublishCoordinates(dto);

    const routeFields = this.resolveDtoSelectedRoute(dto);
    this.assertAssuredRouteGeometryForQueue(routeFields);

    const percentage =
      await this.settingsService.getAssuredRideDepositPercentage();
    const pricePerSeat = BigInt(dto.pricePerSeat);
    const originalDepositAmount = calculateDriverAssuredDeposit(
      dto.totalSeats,
      pricePerSeat,
      percentage,
    );
    const rideId = randomUUID();
    const depositLedgerKey = `assured-driver-deposit:${rideId}`;
    const catalogCode = dto.couponCode?.trim() || null;

    try {
      const created = await this.dataSource.transaction(async (manager) => {
        if (clientKey) {
          const existingAfterLock = await manager.getRepository(Ride).findOne({
            where: { publishIdempotencyKey: key },
          });
          if (existingAfterLock) {
            await this.assertAssuredPublishIdempotentMatches(
              existingAfterLock,
              driverId,
              dto,
              manager,
            );
            return this.toResponse(existingAfterLock);
          }
        }

        // Serialize Assured publishes per driver; partial unique index is the hard guarantee.
        await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `assured-one-active:${driverId}`,
        ]);
        await this.assertNoActiveAssuredRideInTransaction(manager, driverId);

        const wallet = await this.lockWalletForUpdate(manager, driverId);
        this.assertWalletAllowsDeposit(wallet);

        let payableDepositAmount = originalDepositAmount;
        let couponRedemptionId: string | null = null;
        let originalAssuredDepositAmount: string | null = null;
        let couponDiscountAmount: string | null = null;
        let reservedRedemptionId: string | null = null;

        if (catalogCode) {
          const applied =
            await this.couponRedemptionService.reserveInTransaction(manager, {
              userId: driverId,
              rideType: CouponRideTypeScope.ASSURED,
              chargeScope: CouponChargeScope.DRIVER_ASSURED_DEPOSIT,
              amount: originalDepositAmount,
              rideId,
              code: catalogCode,
              idempotencyKey: `${key}:coupon:DRIVER_ASSURED_DEPOSIT`,
              actorContext: CouponActorContext.DRIVER,
              transactionContext:
                CouponTransactionContext.DRIVER_ASSURED_DEPOSIT,
            });
          reservedRedemptionId = applied.redemption.id;
          if (
            applied.redemption.benefitTypeSnapshot !==
            CouponBenefitType.POINTS_CREDIT
          ) {
            originalAssuredDepositAmount = originalDepositAmount.toString();
            payableDepositAmount = applied.finalAmount;
            couponDiscountAmount = applied.discountAmount.toString();
          }
        }

        let driverDepositHoldId: string | null = null;
        if (payableDepositAmount > 0n) {
          const holdResult = await this.walletService.createHoldInTransaction(
            manager,
            {
              walletId: wallet.id,
              amount: payableDepositAmount,
              holdType: WalletHoldType.ASSURED_DEPOSIT,
              referenceType: ASSURED_RIDE_DRIVER_DEPOSIT_REF,
              referenceId: rideId,
              idempotencyKey: depositLedgerKey,
            },
          );
          driverDepositHoldId = holdResult.hold!.id;
        }

        if (reservedRedemptionId) {
          await this.couponRedemptionService.finalizeReservedInTransaction(
            manager,
            reservedRedemptionId,
            wallet.id,
          );
          couponRedemptionId = reservedRedemptionId;
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
          womenOnly: dto.womenOnly === true,
          notes: dto.notes?.trim() ?? null,
          assuredDepositPercentage: percentage,
          assuredDepositAmount: payableDepositAmount.toString(),
          driverDepositHoldId,
          couponRedemptionId,
          originalAssuredDepositAmount,
          couponDiscountAmount,
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

      if (created.status === RideStatus.ASSURANCE_ACTIVE) {
        await this.notificationsService.safeNotifyAssuredPublished({
          rideId: created.id,
          driverId,
        });
      }
      return created;
    } catch (error) {
      if (clientKey && this.isAssuredPublishIdempotencyUniqueViolation(error)) {
        const recovered = await this.rideRepository.findOne({
          where: { publishIdempotencyKey: key },
        });
        if (recovered) {
          await this.assertAssuredPublishIdempotentMatches(
            recovered,
            driverId,
            dto,
          );
          if (recovered.status === RideStatus.ASSURANCE_ACTIVE) {
            await this.notificationsService.safeNotifyAssuredPublished({
              rideId: recovered.id,
              driverId,
            });
          }
          return this.toResponse(recovered);
        }
      }
      if (this.isActiveAssuredRideUniqueViolation(error)) {
        throw new ActiveAssuredRideExistsError();
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

  private assertCommuteSeriesFieldsForRideType(dto: CreateRideDto): void {
    const hasSeriesFields =
      dto.recurring === true ||
      dto.returnEnabled === true ||
      (dto.excludeWeekdays?.length ?? 0) > 0 ||
      Boolean(dto.returnDepartureTime) ||
      Boolean(dto.returnRouteSelectionToken) ||
      Boolean(dto.returnSource) ||
      Boolean(dto.returnDestination);
    if (dto.rideType !== RideType.COMMUTE && hasSeriesFields) {
      throw new BadRequestException(
        'Recurring and return ride fields are only supported for COMMUTE rides',
      );
    }
    if (
      dto.rideType === RideType.COMMUTE &&
      !isCommuteSeriesPublish(dto) &&
      ((dto.excludeWeekdays?.length ?? 0) > 0 ||
        Boolean(dto.returnDepartureTime) ||
        Boolean(dto.returnRouteSelectionToken) ||
        Boolean(dto.returnSource) ||
        Boolean(dto.returnDestination))
    ) {
      throw new BadRequestException(
        'excludeWeekdays and return fields require recurring=true or returnEnabled=true',
      );
    }
  }

  private assertCommutePublishIdempotentMatches(
    existing: Ride,
    driverId: string,
    dto: CreateRideDto,
  ): void {
    if (
      existing.driverId !== driverId ||
      existing.rideType !== RideType.COMMUTE ||
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
        'Idempotency key was reused for a different Commute publish request',
      );
    }
  }

  private isCommuteSlotUniqueViolation(error: unknown): boolean {
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
      (constraint.includes('UQ_rides_commute_driver_slot') ||
        constraint.includes('UQ_rides_commute_vehicle_slot') ||
        detail.includes('UQ_rides_commute_driver_slot') ||
        detail.includes('UQ_rides_commute_vehicle_slot'))
    );
  }

  private async assertAssuredPublishIdempotentMatches(
    existing: Ride,
    driverId: string,
    dto: CreateRideDto,
    manager?: EntityManager,
  ): Promise<void> {
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

    const requestedCode = dto.couponCode?.trim()
      ? normalizeCouponCode(dto.couponCode)
      : null;
    let existingCode: string | null = null;
    if (existing.couponRedemptionId) {
      const redemptionRepo =
        manager?.getRepository(CouponRedemption) ??
        this.dataSource.getRepository(CouponRedemption);
      const redemption = await redemptionRepo.findOne({
        where: { id: existing.couponRedemptionId },
      });
      existingCode = redemption?.codeSnapshot ?? null;
    }
    if (existingCode !== requestedCode) {
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

  private isActiveAssuredRideUniqueViolation(error: unknown): boolean {
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
      (constraint.includes('one_active_assured') ||
        detail.includes('UQ_rides_one_active_assured_per_driver'))
    );
  }

  private async assertNoActiveAssuredRideInTransaction(
    manager: EntityManager,
    driverId: string,
  ): Promise<void> {
    const existing = await manager.getRepository(Ride).findOne({
      where: {
        driverId,
        rideType: RideType.ASSURED,
        status: In([...ACTIVE_ASSURED_RIDE_STATUSES]),
      },
      order: { createdAt: 'ASC' },
    });
    if (existing) {
      throw new ActiveAssuredRideExistsError();
    }
  }

  async findMine(driverId: string): Promise<RideResponseDto[]> {
    const qb = this.rideRepository
      .createQueryBuilder('ride')
      .where('ride.driver_id = :driverId', { driverId })
      .andWhere('ride.status != :cancelled', {
        cancelled: RideStatus.CANCELLED,
      })
      .andWhere(
        new Brackets((inner) => {
          inner
            .where('ride.status NOT IN (:...preTripStatuses)', {
              preTripStatuses: [
                RideStatus.DRAFT,
                RideStatus.PUBLISHED,
                RideStatus.ASSURANCE_PENDING,
                RideStatus.ASSURANCE_ACTIVE,
              ],
            })
            .orWhere(this.futureDepartureSql(), this.futureDepartureParams());
        }),
      )
      .orderBy('ride.departure_date', 'ASC')
      .addOrderBy('ride.departure_time', 'ASC')
      .addOrderBy('ride.created_at', 'DESC');

    const rides = await qb.getMany();
    return rides.map((ride) => this.toResponse(ride));
  }

  /**
   * Home-screen live-ride overview: IN_PROGRESS rides the user drives or
   * has a CONFIRMED booking on. Does not generate OTPs or change lifecycle.
   */
  async findActive(userId: string): Promise<ActiveRidesResponseDto> {
    const [drivenRides, passengerBookings] = await Promise.all([
      this.rideRepository.find({
        where: { driverId: userId, status: RideStatus.IN_PROGRESS },
        order: {
          departureDate: 'ASC',
          departureTime: 'ASC',
          id: 'ASC',
        },
      }),
      this.bookingRepository
        .createQueryBuilder('booking')
        .innerJoinAndSelect('booking.ride', 'ride')
        .where('booking.passenger_id = :userId', { userId })
        .andWhere('booking.status = :confirmed', {
          confirmed: BookingStatus.CONFIRMED,
        })
        .andWhere('ride.status = :inProgress', {
          inProgress: RideStatus.IN_PROGRESS,
        })
        .orderBy('ride.departure_date', 'ASC')
        .addOrderBy('ride.departure_time', 'ASC')
        .addOrderBy('booking.id', 'ASC')
        .getMany(),
    ]);

    const driverRideIds = drivenRides.map((ride) => ride.id);
    const confirmedOnDriven =
      driverRideIds.length === 0
        ? []
        : await this.bookingRepository.find({
            where: {
              rideId: In(driverRideIds),
              status: BookingStatus.CONFIRMED,
            },
            select: {
              id: true,
              rideId: true,
              passengerId: true,
              seats: true,
              totalAmount: true,
              driverShareAmount: true,
              driverPricePerSeatSnapshot: true,
            },
          });

    const bookingsByRideId = new Map<string, Booking[]>();
    for (const booking of confirmedOnDriven) {
      const list = bookingsByRideId.get(booking.rideId) ?? [];
      list.push(booking);
      bookingsByRideId.set(booking.rideId, list);
    }

    const rideById = new Map<string, Ride>();
    for (const ride of drivenRides) {
      rideById.set(ride.id, ride);
    }
    for (const booking of passengerBookings) {
      rideById.set(booking.ride.id, booking.ride);
    }

    const items: ActiveRideItemDto[] = [];
    for (const ride of drivenRides) {
      items.push(
        this.toDriverActiveItem(ride, bookingsByRideId.get(ride.id) ?? []),
      );
    }
    for (const booking of passengerBookings) {
      items.push(this.toPassengerActiveItem(booking, booking.ride));
    }

    items.sort((left, right) => {
      const rideLeft = rideById.get(left.rideId);
      const rideRight = rideById.get(right.rideId);
      const dateCmp = this.toCivilDate(
        rideLeft?.departureDate ?? '',
      ).localeCompare(this.toCivilDate(rideRight?.departureDate ?? ''));
      if (dateCmp !== 0) {
        return dateCmp;
      }
      const timeCmp = (rideLeft?.departureTime ?? '').localeCompare(
        rideRight?.departureTime ?? '',
      );
      if (timeCmp !== 0) {
        return timeCmp;
      }
      if (left.role !== right.role) {
        return left.role === ActiveRideRole.DRIVER ? -1 : 1;
      }
      return left.rideId.localeCompare(right.rideId);
    });

    return { items };
  }

  /**
   * Paginated past rides for the owning driver (COMPLETED / CANCELLED only).
   * Includes cancelled Daily Office Commute series occurrences (outbound and
   * return). Does not include PUBLISHED or IN_PROGRESS.
   *
   * Order: scheduled departure_date DESC, departure_time DESC, then
   * updated_at DESC. Cancelled rides keep status CANCELLED and expose
   * cancelledAt when the cancellation service stored it; they are not
   * sorted as COMPLETED.
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
        driverShare: booking.driverShareAmount,
        platformShare: booking.platformShareAmount,
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

    const timing = this.computeHistoryTripTiming(ride, bookings);
    const earnings = this.calculateHistoryEarnings(bookings);
    const bonuses = await this.loadRideDriverBonusEarnings(
      ride.driverId,
      ride.id,
      bookings.map((booking) => booking.id),
    );
    earnings.assuredBonus = bonuses.assuredBonus;
    earnings.otherEarnings = bonuses.otherEarnings;
    earnings.total = (
      BigInt(earnings.driverShare) +
      BigInt(bonuses.assuredBonus ?? '0') +
      BigInt(bonuses.otherEarnings ?? '0')
    ).toString();

    return {
      ride: this.toHistoryTrip(ride, bookedSeats, timing),
      vehicle: vehicle ? this.toHistoryVehicle(vehicle, vehicleVerified) : null,
      passengers,
      earnings,
    };
  }

  async findOne(requesterId: string, rideId: string): Promise<RideResponseDto> {
    const ride = await this.requireOwnedRide(requesterId, rideId);
    if (!ride.seriesId) {
      return this.toResponse(ride);
    }
    const series = await this.dataSource.getRepository(RideSeries).findOne({
      where: { id: ride.seriesId },
    });
    const occurrences = await this.rideRepository.find({
      where: { seriesId: ride.seriesId },
      order: { occurrenceDate: 'ASC', departureTime: 'ASC', id: 'ASC' },
    });
    return this.toResponse(ride, {
      series: series ?? undefined,
      occurrences,
    });
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

  /**
   * Passenger discovery.
   *
   * Coordinate search uses the persisted driver-selected polyline only
   * (bbox prefilter + batched geometry). It never calls Directions and never
   * synthesizes a straight-line route. Rides with missing/invalid polylines
   * are logged and excluded. Place-name search (no coordinates) still uses
   * LIKE on source/destination text, including legacy rides without geometry.
   * Assured geographic queue compatibility is a separate 50 km algorithm.
   */
  async search(
    searcherUserId: string,
    dto: SearchRidesDto,
  ): Promise<RideSearchPageDto> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const useCorridor = this.hasCompleteSearchCoordinates(dto);

    const qb = this.rideRepository
      .createQueryBuilder('ride')
      .where('ride.departure_date = :date', { date: dto.date });
    this.applyPassengerVisibilityFilter(qb);
    this.applyFutureDepartureFilter(qb);
    qb.andWhere('ride.driver_id != :searcherUserId', {
      searcherUserId,
    });

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
    const latPad = SOURCE_CATCHMENT_METERS / 111_320;
    const cos = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
    const lngPad = SOURCE_CATCHMENT_METERS / (111_320 * cos);

    qb.andWhere('ride.route_polyline IS NOT NULL')
      .andWhere('ride.route_bbox_min_lat IS NOT NULL')
      .andWhere(
        `
        :pickupLat BETWEEN (ride.route_bbox_min_lat - :latPad)
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
      );

    qb.orderBy('ride.departure_date', 'ASC')
      .addOrderBy('ride.departure_time', 'ASC')
      .addOrderBy('ride.created_at', 'ASC');

    const matched: Ride[] = [];
    const batchSize = 200;
    let offset = 0;
    for (;;) {
      const batch = await qb.clone().skip(offset).take(batchSize).getMany();
      if (batch.length === 0) {
        break;
      }
      for (const ride of batch) {
        if (this.rideMatchesSelectedRouteSearch(ride, pickup, dropoff)) {
          matched.push(ride);
        }
      }
      offset += batch.length;
      if (batch.length < batchSize) {
        break;
      }
    }

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
    const { seriesScope, ...ridePatch } = dto;
    const scope = seriesScope ?? SeriesScope.THIS_OCCURRENCE;

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

      if (
        scope === SeriesScope.THIS_AND_FUTURE &&
        (ride.rideType !== RideType.COMMUTE || !ride.seriesId)
      ) {
        throw new BadRequestException(
          'seriesScope=THIS_AND_FUTURE is only valid for Daily Office Commute series occurrences',
        );
      }

      if (
        ride.seriesId &&
        ridePatch.rideType !== undefined &&
        ridePatch.rideType !== RideType.COMMUTE
      ) {
        throw new BadRequestException(
          'Commute series occurrences cannot change rideType',
        );
      }

      if (
        scope === SeriesScope.THIS_AND_FUTURE &&
        ridePatch.departureDate !== undefined &&
        this.toCivilDate(ridePatch.departureDate) !==
          this.toCivilDate(ride.departureDate)
      ) {
        throw new BadRequestException(
          'THIS_AND_FUTURE cannot change occurrence dates; update departureTime or cancel individual dates instead',
        );
      }

      if (
        scope === SeriesScope.THIS_AND_FUTURE &&
        ride.rideType === RideType.COMMUTE &&
        ride.seriesId
      ) {
        const targets =
          await this.commuteRideSeriesService.findSameDirectionScope(
            manager,
            ride,
            SeriesScope.THIS_AND_FUTURE,
          );
        const eligible = targets.filter(
          (target) =>
            target.status === RideStatus.PUBLISHED &&
            !isPastOccurrence(target),
        );
        if (eligible.length === 0) {
          throw new ConflictException(
            'No eligible future occurrences in this series can be updated',
          );
        }

        const blockedIds: string[] = [];
        for (const target of eligible) {
          const bookedSeats = await this.sumActiveBookedSeats(
            manager,
            target.id,
          );
          if (bookedSeats > 0) {
            try {
              this.assertRegularProtectedFieldsUnchanged(target, ridePatch);
            } catch {
              blockedIds.push(target.id);
            }
          }
        }
        if (blockedIds.length > 0) {
          throw new ConflictException({
            statusCode: 409,
            code: 'COMMUTE_SERIES_OCCURRENCES_BOOKED',
            message:
              'Some future occurrences already have bookings and cannot accept this update. Use THIS_OCCURRENCE or cancel bookings first.',
            blockedRideIds: blockedIds,
            error: 'Conflict',
          });
        }

        for (const target of eligible) {
          await this.applyRegularRideUpdate(
            manager,
            driverId,
            target,
            ridePatch,
          );
          await manager.getRepository(Ride).save(target);
        }

        const fresh = eligible.find((row) => row.id === ride.id) ?? eligible[0];
        return this.toResponse(fresh);
      }

      if (
        ride.rideType === RideType.REGULAR ||
        ride.rideType === RideType.COMMUTE
      ) {
        await this.applyRegularRideUpdate(manager, driverId, ride, ridePatch);
      } else {
        await this.applyAssuredRideUpdate(manager, driverId, ride, ridePatch);
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
    if (bookedSeats > 0) {
      this.assertWomenOnlyUnchangedAfterBooking(ride, dto);
    }
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
    if (
      isAtOrAfterDeparture(
        new Date(),
        this.toCivilDate(ride.departureDate),
        this.normalizeTime(this.formatTime(ride.departureTime)),
      )
    ) {
      return false;
    }
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

  /**
   * Keep only rides whose civil departure is still strictly in the future
   * in Asia/Kolkata. Parameterized so Postgres compares date+time columns
   * without depending on the Node process timezone.
   */
  private applyFutureDepartureFilter(
    qb: ReturnType<Repository<Ride>['createQueryBuilder']>,
  ): void {
    qb.andWhere(this.futureDepartureSql(), this.futureDepartureParams());
  }

  private futureDepartureSql(): string {
    return '(ride.departure_date > :nowCivilDate OR (ride.departure_date = :nowCivilDate AND ride.departure_time > :nowCivilTime))';
  }

  private futureDepartureParams(): { nowCivilDate: string; nowCivilTime: string } {
    const clock = currentCivilClock();
    return { nowCivilDate: clock.date, nowCivilTime: clock.time };
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
    if (dto.departureDate !== undefined || dto.departureTime !== undefined) {
      assertDepartureIsInFuture(
        this.toCivilDate(ride.departureDate),
        this.normalizeTime(this.formatTime(ride.departureTime)),
      );
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
    if (dto.womenOnly !== undefined) {
      ride.womenOnly =
        ride.rideType === RideType.COMMUTE ? false : dto.womenOnly === true;
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
      if (!dto.routeSelectionToken?.trim()) {
        throw new BadRequestException(
          'A selected driving route is required when changing source, destination, or coordinates. Request POST /rides/route-options and pass routeSelectionToken.',
        );
      }
      const routeFields = this.resolveDtoSelectedRoute({
        routeSelectionToken: dto.routeSelectionToken,
        sourceLatitude: dto.sourceLatitude ?? ride.sourceLatitude ?? undefined,
        sourceLongitude:
          dto.sourceLongitude ?? ride.sourceLongitude ?? undefined,
        destinationLatitude:
          dto.destinationLatitude ?? ride.destinationLatitude ?? undefined,
        destinationLongitude:
          dto.destinationLongitude ?? ride.destinationLongitude ?? undefined,
      });
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
      (dto.womenOnly !== undefined && dto.womenOnly !== ride.womenOnly) ||
      (dto.notes !== undefined &&
        (dto.notes?.trim() ?? null) !== (ride.notes?.trim() ?? null));

    if (protectedChanged) {
      throw new ConflictException(
        'Ride details cannot be modified after a booking has been made. Only seats can be changed.',
      );
    }
  }

  private assertWomenOnlyUnchangedAfterBooking(
    ride: Ride,
    dto: UpdateRideDto,
  ): void {
    if (dto.womenOnly !== undefined && dto.womenOnly !== ride.womenOnly) {
      throw new ConflictException(
        'womenOnly cannot be changed after a booking has been made.',
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

  private rideMatchesSelectedRouteSearch(
    ride: Ride,
    pickup: LatLng,
    dropoff: LatLng,
  ): boolean {
    if (!ride.routePolyline) {
      this.logger.warn(
        `Corridor search skipped ride=${ride.id}: missing selected route geometry`,
      );
      return false;
    }
    try {
      const routePoints = decodePolyline(ride.routePolyline);
      if (routePoints.length < 2) {
        this.logger.warn(
          `Corridor search skipped ride=${ride.id}: invalid route polyline`,
        );
        return false;
      }
      return matchesSelectedDriverRoute({
        routePoints,
        pickup,
        dropoff,
        source:
          ride.sourceLatitude != null && ride.sourceLongitude != null
            ? {
                latitude: ride.sourceLatitude,
                longitude: ride.sourceLongitude,
              }
            : routePoints[0],
        destination:
          ride.destinationLatitude != null && ride.destinationLongitude != null
            ? {
                latitude: ride.destinationLatitude,
                longitude: ride.destinationLongitude,
              }
            : routePoints[routePoints.length - 1],
      });
    } catch (error) {
      this.logger.warn(
        `Corridor search skipped ride=${ride.id}: ${
          error instanceof Error ? error.message : 'invalid geometry'
        }`,
      );
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
        dto.destinationLatitude === null ? undefined : dto.destinationLatitude,
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
   * Controlled legacy backfill. Uses the directions provider only — never a
   * straight line — and does not mark the result as driver-selected.
   * Not invoked from passenger search.
   */
  async backfillLegacyRideGeometry(rideId: string): Promise<boolean> {
    const ride = await this.rideRepository.findOne({ where: { id: rideId } });
    if (!ride || ride.routePolyline) {
      return false;
    }
    if (
      ride.sourceLatitude == null ||
      ride.sourceLongitude == null ||
      ride.destinationLatitude == null ||
      ride.destinationLongitude == null
    ) {
      this.logger.warn(
        `Legacy route backfill skipped ride=${ride.id}: missing endpoint coordinates`,
      );
      return false;
    }
    const option = await this.rideDirectionsService.buildDrivingRouteGeometry(
      {
        latitude: ride.sourceLatitude,
        longitude: ride.sourceLongitude,
      },
      {
        latitude: ride.destinationLatitude,
        longitude: ride.destinationLongitude,
      },
    );
    if (!option) {
      this.logger.warn(
        `Legacy route backfill skipped ride=${ride.id}: directions unavailable`,
      );
      return false;
    }
    ride.routePolyline = option.polylineEncoded;
    ride.routeLengthMeters = option.lengthMeters;
    ride.routeBboxMinLat = option.bbox.minLat;
    ride.routeBboxMaxLat = option.bbox.maxLat;
    ride.routeBboxMinLng = option.bbox.minLng;
    ride.routeBboxMaxLng = option.bbox.maxLng;
    ride.routeDurationSeconds = option.durationSeconds;
    ride.routeSelectionId = null;
    ride.routeSelectedAt = null;
    await this.rideRepository.save(ride);
    this.logger.log(
      `Legacy route backfill stored provider geometry for ride=${ride.id} (not driver-selected)`,
    );
    return true;
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
      throw new BadRequestException(
        'Invalid source or destination coordinates',
      );
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
    return toCivilDateString(value);
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
   * Dedicated completion for trip-lifecycle rides (Regular, Assured, and Commute).
   * All types require IN_PROGRESS and confirmed passengers PICKED_UP before completion.
   * Commute uses prepaid settlement (driver share + platform margin); Regular/Assured use fare settlement.
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
          // Idempotent retry path: ensure qualifying trips were recorded.
          if (ride.rideType === RideType.COMMUTE) {
            await this.commuteRewardProgressService.recordQualifyingRideInTransaction(
              manager,
              ride,
            );
          }
          return this.buildCompleteResponse(manager, ride, true);
        }

        if (ride.status === RideStatus.CANCELLED) {
          throw new ConflictException('Cancelled rides cannot be completed');
        }

        if (ride.status === RideStatus.DRAFT) {
          throw new ConflictException('Draft rides cannot be completed');
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
          .andWhere('booking.status = :confirmed', {
            confirmed: BookingStatus.CONFIRMED,
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

        let commuteSettlement: CommuteRideSettlementSummary | undefined;

        if (ride.rideType === RideType.COMMUTE) {
          const confirmedCommuteBookings = activeBookings.filter(
            (booking) =>
              booking.bookingMode === BookingMode.COMMUTE &&
              booking.status === BookingStatus.CONFIRMED,
          );
          commuteSettlement =
            await this.commuteSettlementService.settleCommuteRideInTransaction(
              manager,
              {
                ride,
                driverId: ride.driverId,
                bookings: confirmedCommuteBookings,
              },
            );
        } else {
          await this.fareSettlementService.settleRideFaresInTransaction(
            manager,
            {
              ride,
              driverId: ride.driverId,
              bookings: activeBookings,
            },
          );
        }

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

        if (ride.rideType === RideType.COMMUTE) {
          await manager
            .getRepository(Booking)
            .createQueryBuilder()
            .update(Booking)
            .set({ status: BookingStatus.COMPLETED })
            .where('ride_id = :rideId', { rideId: ride.id })
            .andWhere('booking_mode = :mode', { mode: BookingMode.COMMUTE })
            .andWhere('status = :status', { status: BookingStatus.CONFIRMED })
            .execute();
        } else {
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
        }

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
        ride.completedAt = new Date();
        await this.ratingsService.createRatingTasksInTransaction(manager, ride);
        await manager.getRepository(Ride).save(ride);

        // Coupon auto-issuance hook (inactive rules ⇒ no-op; idempotent).
        const passengerUserIds = [
          ...new Set(activeBookings.map((b) => b.passengerId)),
        ];
        await this.couponIssuanceService.onTripCompletedInTransaction(manager, {
          tripId: ride.id,
          passengerUserIds,
          rideType: ride.rideType,
        });

        if (ride.rideType === RideType.COMMUTE) {
          await this.commuteRewardProgressService.recordQualifyingRideInTransaction(
            manager,
            ride,
          );
        }

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

        if (ride.rideType === RideType.COMMUTE) {
          return {
            rideId: ride.id,
            status: RideStatus.COMPLETED,
            rideType: ride.rideType,
            alreadyCompleted: false,
            commuteSettlement,
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
      await this.chatService.safeCloseForRide(rideId);

      try {
        await this.invoicesService.scheduleForCompletedRide(rideId);
      } catch (error) {
        this.logger.warn(
          `Invoice scheduling failed after ride completion ride=${rideId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
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
    await this.ratingsService.createRatingTasksInTransaction(manager, ride);

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

    const [profiles, vehicles, driverRatings, recentRidesByDriver] =
      await Promise.all([
        this.userProfileRepository.find({
          where: { userId: In(driverIds) },
        }),
        this.vehicleRepository.find({
          where: { id: In(vehicleIds) },
          withDeleted: true,
        }),
        this.ratingsService.getDriverRatingAveragesForUsers(driverIds),
        this.loadDriverRecentTerminalRides(driverIds),
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
              seriesId: ride.seriesId,
              direction: ride.direction,
            }
          : {}),
        preferences: {
          maxTwoInBackSeat: ride.maxTwoInBackSeat,
          noSmoking: ride.noSmoking,
          noPets: ride.noPets,
          luggageAllowed: ride.luggageAllowed,
          womenOnly: ride.womenOnly,
        },
        notes: ride.notes,
        assuredDepositPercentage:
          ride.rideType === RideType.ASSURED
            ? ride.assuredDepositPercentage
            : null,
        assuredDepositAmount:
          ride.rideType === RideType.ASSURED ? ride.assuredDepositAmount : null,
        driver: {
          id: ride.driverId,
          displayName: profile?.displayName ?? profile?.firstName ?? null,
          profilePhoto: profile?.profilePhoto ?? null,
          rating: driverRatings.get(ride.driverId) ?? {
            averageRating: 0,
            totalRatings: 0,
          },
          recentRides: recentRidesByDriver.get(ride.driverId) ?? [],
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

  /**
   * Last 5 COMPLETED/CANCELLED rides per driver for passenger discovery cards.
   */
  private async loadDriverRecentTerminalRides(driverIds: string[]): Promise<
    Map<
      string,
      Array<{
        id: string;
        date: string;
        source: string;
        destination: string;
        status: RideStatus.COMPLETED | RideStatus.CANCELLED;
      }>
    >
  > {
    const result = new Map<
      string,
      Array<{
        id: string;
        date: string;
        source: string;
        destination: string;
        status: RideStatus.COMPLETED | RideStatus.CANCELLED;
      }>
    >(driverIds.map((id) => [id, []]));

    if (driverIds.length === 0) {
      return result;
    }

    const rows: Array<{
      id: string;
      driver_id: string;
      source: string;
      destination: string;
      departure_date: string;
      status: RideStatus.COMPLETED | RideStatus.CANCELLED;
    }> = await this.rideRepository.query(
      `
      SELECT id, driver_id, source, destination, departure_date, status
      FROM (
        SELECT
          id,
          driver_id,
          source,
          destination,
          departure_date::text AS departure_date,
          status,
          ROW_NUMBER() OVER (
            PARTITION BY driver_id
            ORDER BY departure_date DESC, departure_time DESC, updated_at DESC
          ) AS rn
        FROM rides
        WHERE driver_id = ANY($1::uuid[])
          AND status IN ('COMPLETED', 'CANCELLED')
      ) ranked
      WHERE rn <= 5
      ORDER BY driver_id ASC, rn ASC
      `,
      [driverIds],
    );

    for (const row of rows) {
      const list = result.get(row.driver_id) ?? [];
      list.push({
        id: row.id,
        date: String(row.departure_date).slice(0, 10),
        source: row.source,
        destination: row.destination,
        status: row.status,
      });
      result.set(row.driver_id, list);
    }

    return result;
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
      throw new ForbiddenException({
        statusCode: 403,
        code:
          user.status === UserStatus.SUSPENDED
            ? 'USER_SUSPENDED'
            : 'USER_NOT_ACTIVE',
        message: 'User status does not allow publishing rides',
        error: 'Forbidden',
      });
    }

    if (user.ridePublishRestricted) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'USER_RIDE_PUBLISH_RESTRICTED',
        message:
          user.ridePublishRestrictedReason?.trim() ||
          'Ride publishing is restricted on this account',
        error: 'Forbidden',
      });
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
          if (type === VerificationType.DRIVING_LICENSE)
            return 'driving license';
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
          driverShareAmount: true,
          platformShareAmount: true,
          pickupVerifiedAt: true,
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
    const vehicleVerifiedByUserId = await this.resolveVerificationFlags(
      vehicleOwnerIds,
      VerificationType.VEHICLE,
    );

    const bonusByRideId = await this.loadRideDriverBonusEarningsBatch(
      rides.map((ride) => ({
        rideId: ride.id,
        driverId: ride.driverId,
        bookingIds: (bookingsByRideId.get(ride.id) ?? []).map(
          (booking) => booking.id,
        ),
      })),
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
      const earnings = this.calculateHistoryEarnings(rideBookings);
      const bonuses = bonusByRideId.get(ride.id) ?? {
        assuredBonus: null,
        otherEarnings: null,
      };
      earnings.assuredBonus = bonuses.assuredBonus;
      earnings.otherEarnings = bonuses.otherEarnings;
      earnings.total = (
        BigInt(earnings.driverShare) +
        BigInt(bonuses.assuredBonus ?? '0') +
        BigInt(bonuses.otherEarnings ?? '0')
      ).toString();

      return {
        ride: this.toHistoryTrip(
          ride,
          bookedSeats,
          this.computeHistoryTripTiming(ride, rideBookings),
        ),
        vehicle: vehicle
          ? this.toHistoryVehicle(
              vehicle,
              vehicleVerifiedByUserId.get(vehicle.userId) === true,
            )
          : null,
        earnings,
        passengerCount: rideBookings.length,
      };
    });
  }

  private toHistoryTrip(
    ride: Ride,
    bookedSeats: number,
    timing?: { startedAt: string | null; durationMinutes: number | null },
  ): RideHistoryTripDto {
    return {
      id: ride.id,
      status: ride.status,
      rideType: ride.rideType,
      source: ride.source,
      destination: ride.destination,
      sourceLatitude: ride.sourceLatitude,
      sourceLongitude: ride.sourceLongitude,
      destinationLatitude: ride.destinationLatitude,
      destinationLongitude: ride.destinationLongitude,
      departureDate: this.toCivilDate(ride.departureDate),
      departureTime: this.formatTime(ride.departureTime),
      startedAt: timing?.startedAt ?? null,
      completedAt: ride.completedAt?.toISOString() ?? null,
      cancelledAt: ride.cancelledAt?.toISOString() ?? null,
      durationMinutes: timing?.durationMinutes ?? null,
      distanceKm: this.metersToDistanceKm(ride.routeLengthMeters),
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
      vehicleType: vehicle.vehicleType,
      make: vehicle.make,
      model: vehicle.model,
      variant: vehicle.variant,
      color: vehicle.color,
      registrationNumber: vehicle.registrationNumber,
      registrationYear: vehicle.registrationYear,
      seatingCapacity: vehicle.seatingCapacity,
      isVerified,
    };
  }

  private toDriverActiveItem(
    ride: Ride,
    confirmedBookings: Booking[],
  ): ActiveRideItemDto {
    const passengerIds = new Set(
      confirmedBookings.map((booking) => booking.passengerId),
    );
    let totalFare = 0n;
    for (const booking of confirmedBookings) {
      totalFare += this.driverFacingBookingFare(booking);
    }
    return {
      rideId: ride.id,
      role: ActiveRideRole.DRIVER,
      rideType: ride.rideType,
      status: RideStatus.IN_PROGRESS,
      source: ride.source,
      destination: ride.destination,
      totalPassengers: passengerIds.size,
      totalFare: totalFare.toString(),
      seriesId: ride.seriesId ?? null,
      occurrenceDate: ride.occurrenceDate
        ? this.toCivilDate(ride.occurrenceDate)
        : null,
      direction: ride.direction ?? null,
    };
  }

  private toPassengerActiveItem(
    booking: Booking,
    ride: Ride,
  ): ActiveRideItemDto {
    return {
      rideId: ride.id,
      bookingId: booking.id,
      role: ActiveRideRole.PASSENGER,
      rideType: ride.rideType,
      status: RideStatus.IN_PROGRESS,
      source: ride.source,
      destination: ride.destination,
      fare: booking.totalAmount,
      otp: this.bookingsService.visiblePickupOtpForPassenger(booking),
      seriesId: ride.seriesId ?? null,
      occurrenceDate: ride.occurrenceDate
        ? this.toCivilDate(ride.occurrenceDate)
        : null,
      direction: ride.direction ?? null,
    };
  }

  /**
   * Driver-facing fare for an active CONFIRMED booking.
   * Commute: settled driverShareAmount, else published driver price × seats.
   * Regular/Assured: persisted booking totalAmount.
   */
  private driverFacingBookingFare(
    booking: Pick<
      Booking,
      'seats' | 'totalAmount' | 'driverShareAmount' | 'driverPricePerSeatSnapshot'
    >,
  ): bigint {
    if (booking.driverShareAmount != null) {
      return BigInt(booking.driverShareAmount);
    }
    if (booking.driverPricePerSeatSnapshot != null) {
      return BigInt(booking.driverPricePerSeatSnapshot) * BigInt(booking.seats);
    }
    return BigInt(booking.totalAmount);
  }

  private calculateHistoryEarnings(
    bookings: Array<
      Pick<
        Booking,
        'status' | 'totalAmount' | 'driverShareAmount' | 'platformShareAmount'
      >
    >,
  ): RideHistoryEarningsDto {
    let passengerTotal = 0n;
    let driverShare = 0n;
    let platformShare = 0n;

    for (const booking of bookings) {
      if (booking.status !== BookingStatus.COMPLETED) {
        continue;
      }

      const fare = BigInt(booking.totalAmount);
      passengerTotal += fare;

      if (booking.driverShareAmount != null) {
        driverShare += BigInt(booking.driverShareAmount);
        platformShare += BigInt(booking.platformShareAmount ?? '0');
      } else {
        driverShare += fare;
      }
    }

    return {
      passengerTotal: passengerTotal.toString(),
      driverShare: driverShare.toString(),
      platformShare: platformShare > 0n ? platformShare.toString() : null,
      assuredBonus: null,
      otherEarnings: null,
      total: driverShare.toString(),
    };
  }

  private computeHistoryTripTiming(
    ride: Ride,
    bookings: Array<Pick<Booking, 'pickupVerifiedAt'>>,
  ): { startedAt: string | null; durationMinutes: number | null } {
    const pickupTimes = bookings
      .map((booking) => booking.pickupVerifiedAt)
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => a.getTime() - b.getTime());

    const startedAt = pickupTimes[0] ?? null;
    if (!startedAt || !ride.completedAt) {
      return {
        startedAt: startedAt?.toISOString() ?? null,
        durationMinutes: null,
      };
    }

    const durationMinutes = Math.round(
      (ride.completedAt.getTime() - startedAt.getTime()) / 60_000,
    );

    return {
      startedAt: startedAt.toISOString(),
      durationMinutes: durationMinutes >= 0 ? durationMinutes : null,
    };
  }

  private metersToDistanceKm(meters: number | null): number | null {
    if (meters == null || !Number.isFinite(meters) || meters < 0) {
      return null;
    }
    return Math.round((meters / 1000) * 100) / 100;
  }

  private async loadRideDriverBonusEarnings(
    driverId: string,
    rideId: string,
    bookingIds: string[],
  ): Promise<{ assuredBonus: string | null; otherEarnings: string | null }> {
    const batch = await this.loadRideDriverBonusEarningsBatch([
      { rideId, driverId, bookingIds },
    ]);
    return (
      batch.get(rideId) ?? {
        assuredBonus: null,
        otherEarnings: null,
      }
    );
  }

  private async loadRideDriverBonusEarningsBatch(
    rides: Array<{ rideId: string; driverId: string; bookingIds: string[] }>,
  ): Promise<
    Map<string, { assuredBonus: string | null; otherEarnings: string | null }>
  > {
    const result = new Map<
      string,
      { assuredBonus: string | null; otherEarnings: string | null }
    >();
    for (const ride of rides) {
      result.set(ride.rideId, { assuredBonus: null, otherEarnings: null });
    }
    if (rides.length === 0) {
      return result;
    }

    const rideIds = rides.map((ride) => ride.rideId);
    const bookingIds = [
      ...new Set(rides.flatMap((ride) => ride.bookingIds).filter(Boolean)),
    ];
    const driverIds = [...new Set(rides.map((ride) => ride.driverId))];

    const txRepository = this.dataSource.getRepository(WalletTransaction);
    const qb = txRepository
      .createQueryBuilder('tx')
      .where('tx.user_id IN (:...driverIds)', { driverIds })
      .andWhere('tx.direction = :direction', {
        direction: WalletTransactionDirection.CREDIT,
      })
      .andWhere('tx.status = :status', {
        status: WalletTransactionStatus.POSTED,
      });

    qb.andWhere(
      new Brackets((sub) => {
        sub.where(
          `tx.transaction_type = :assuredBonusType
           AND tx.reference_type = :rideRefType
           AND tx.reference_id IN (:...rideIds)`,
          {
            assuredBonusType:
              WalletTransactionType.ASSURED_PARTIAL_FILL_COMPENSATION,
            rideRefType: 'ASSURED_PARTIAL_FILL_COMPENSATION',
            rideIds,
          },
        );

        if (bookingIds.length > 0) {
          sub.orWhere(
            `tx.transaction_type IN (:...otherTypes)
             AND tx.reference_type IN (:...bookingRefTypes)
             AND tx.reference_id IN (:...bookingIds)`,
            {
              otherTypes: [
                WalletTransactionType.ASSURED_PASSENGER_CANCEL_DEPOSIT_DRIVER,
                WalletTransactionType.ASSURED_PASSENGER_CANCEL_FARE_DRIVER,
              ],
              bookingRefTypes: [
                'ASSURED_PASSENGER_CANCEL_DEPOSIT',
                'ASSURED_PASSENGER_CANCEL_FARE',
              ],
              bookingIds,
            },
          );
        }
      }),
    );

    const rows = await qb.getMany();

    const bookingToRideId = new Map<string, string>();
    for (const ride of rides) {
      for (const bookingId of ride.bookingIds) {
        bookingToRideId.set(bookingId, ride.rideId);
      }
    }

    const assuredByRide = new Map<string, bigint>();
    const otherByRide = new Map<string, bigint>();

    for (const tx of rows) {
      if (
        tx.transactionType ===
          WalletTransactionType.ASSURED_PARTIAL_FILL_COMPENSATION &&
        tx.referenceId
      ) {
        const amount = BigInt(tx.amount);
        assuredByRide.set(
          tx.referenceId,
          (assuredByRide.get(tx.referenceId) ?? 0n) + amount,
        );
        continue;
      }

      if (!tx.referenceId) {
        continue;
      }
      const rideId = bookingToRideId.get(tx.referenceId);
      if (!rideId) {
        continue;
      }
      const amount = BigInt(tx.amount);
      otherByRide.set(rideId, (otherByRide.get(rideId) ?? 0n) + amount);
    }

    for (const ride of rides) {
      const assured = assuredByRide.get(ride.rideId) ?? 0n;
      const other = otherByRide.get(ride.rideId) ?? 0n;
      result.set(ride.rideId, {
        assuredBonus: assured > 0n ? assured.toString() : null,
        otherEarnings: other > 0n ? other.toString() : null,
      });
    }

    return result;
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

  private toResponse(
    ride: Ride,
    options?: { series?: RideSeries; occurrences?: Ride[] },
  ): RideResponseDto {
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
      womenOnly: ride.womenOnly,
      notes: ride.notes,
      assuredDepositPercentage: ride.assuredDepositPercentage,
      assuredDepositAmount: ride.assuredDepositAmount,
      originalAssuredDepositAmount: ride.originalAssuredDepositAmount ?? null,
      couponDiscountAmount: ride.couponDiscountAmount ?? null,
      couponRedemptionId: ride.couponRedemptionId ?? null,
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
      routeSelected: ride.routeSelectedAt != null,
      routeLengthMeters: ride.routeLengthMeters,
      routeDurationSeconds: ride.routeDurationSeconds,
      seriesId: ride.seriesId ?? null,
      occurrenceDate: ride.occurrenceDate
        ? this.toCivilDate(ride.occurrenceDate)
        : null,
      direction: ride.direction ?? null,
      isOriginalOccurrence: Boolean(
        options?.series?.originalRideId &&
          options.series.originalRideId === ride.id,
      ),
      ...(options?.series
        ? {
            series: {
              id: options.series.id,
              status: options.series.status,
              startDate: this.toCivilDate(options.series.startDate),
              endDate: this.toCivilDate(options.series.endDate),
              excludedWeekdays: options.series.excludedWeekdays ?? [],
              returnEnabled: options.series.returnEnabled,
              returnDepartureTime: options.series.returnDepartureTime
                ? this.formatTime(options.series.returnDepartureTime)
                : null,
              originalRideId: options.series.originalRideId,
              occurrences: (options.occurrences ?? []).map((occurrence) =>
                this.toResponse(occurrence),
              ),
            },
          }
        : {}),
      createdAt: ride.createdAt.toISOString(),
      updatedAt: ride.updatedAt.toISOString(),
    };
  }

  private formatTime(value: string): string {
    return value.length >= 8 ? value.slice(0, 8) : value;
  }
}
