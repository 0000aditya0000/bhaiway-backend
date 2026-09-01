import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import {
  DataSource,
  EntityManager,
  In,
  QueryFailedError,
  Repository,
} from 'typeorm';

import {
  SECURITY_DEPOSIT_REASON_PREVIOUS_CANCELLATION,
  PassengerAssuredDepositPenaltyService,
} from '../assured/passenger-assured-deposit-penalty.service';
import { AssuredLifecycleService } from '../assured/assured-lifecycle.service';
import { AssuredQueueService } from '../assured/assured-queue.service';
import {
  isAssuredBookableStatus,
  isCommutePublishedStatus,
  isRegularPublishedStatus,
} from '../assured/assured-ride-status';
import {
  AssuredBookingLifecycleResponseDto,
} from '../assured/dto/assured-lifecycle-response.dto';
import {
  ASSURED_BOOKING_RIDER_DEPOSIT_REF,
  calculateRiderAssuredDeposit,
} from '../assured/assured-deposit.math';
import {
  UserCoupon,
  UserCouponStatus,
  UserCouponType,
} from '../coupons/entities/user-coupon.entity';
import { Ride } from '../rides/entities/ride.entity';
import {
  RegularSeatsPolicy,
  RideStatus,
  RideType,
} from '../rides/enums/ride.enums';
import { supportsTripLifecycle } from '../rides/ride-trip-lifecycle';
import { computeCommuteBookingFareSnapshots } from '../rides/commute-fare.math';
import {
  FareSettlementService,
  RegularPayLaterSettlementResult,
} from '../fare/fare-settlement.service';
import { SettingsService } from '../settings/settings.service';
import { User } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { VerificationService } from '../verification/verification.service';
import {
  InsufficientWalletBalanceError,
  PlatformWalletForbiddenError,
  WalletBalanceNotFoundError,
  WalletNotFoundError,
  WalletOperationConflictError,
} from '../wallet/errors/wallet.errors';
import { WalletHoldType } from '../wallet/entities/wallet-hold.entity';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import { WalletTransactionType } from '../wallet/entities/wallet-transaction.entity';
import { Wallet, WalletStatus } from '../wallet/entities/wallet.entity';
import { WalletService } from '../wallet/wallet.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import {
  BookingCoPassengerDto,
  BookingDriverDto,
  BookingResponseDto,
  BookingVehicleSnapshotDto,
} from './dto/booking-response.dto';
import { BookingHistoryQueryDto } from './dto/booking-history-query.dto';
import {
  BookingHistoryDetailDto,
  BookingHistoryDriverDto,
  BookingHistoryFareBreakdownDto,
  BookingHistoryListItemDto,
  BookingHistoryPageDto,
  BookingHistoryTripDto,
  BookingHistoryVehicleDto,
} from './dto/booking-history-response.dto';
import { DriverBookingsQueryDto } from './dto/driver-bookings-query.dto';
import {
  DriverBookingItemDto,
  DriverBookingPageDto,
} from './dto/driver-booking-response.dto';
import { CommuteBookingDriverActionResponseDto } from './dto/commute-booking-action-response.dto';
import { RegularPayLaterPaymentResponseDto } from './dto/regular-pay-later-payment-response.dto';
import { VerifyPickupResponseDto } from './dto/verify-pickup-response.dto';
import { Booking } from './entities/booking.entity';
import {
  BookingFarePayment,
  BookingMode,
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingPickupStatus,
  BookingStatus,
  BookingCancellationReason,
} from './enums/booking.enums';
import {
  decryptPickupOtp,
  encryptPickupOtp,
  generatePickupOtp,
  hashPickupOtp,
  isValidPickupOtpFormat,
  PICKUP_OTP_MAX_ATTEMPTS,
  PICKUP_OTP_TTL_MS,
  pickupOtpHashesMatch,
} from './pickup-otp.util';
import { UserVerification } from '../verification/entities/user-verification.entity';
import {
  VerificationStatus,
  VerificationType,
} from '../verification/enums/verification.enums';

export interface CreateBookingOptions {
  idempotencyKey?: string | null;
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserProfile)
    private readonly userProfileRepository: Repository<UserProfile>,
    @InjectRepository(UserVerification)
    private readonly verificationRepository: Repository<UserVerification>,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @InjectRepository(UserCoupon)
    private readonly userCouponRepository: Repository<UserCoupon>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepository: Repository<Vehicle>,
    private readonly verificationService: VerificationService,
    private readonly walletService: WalletService,
    private readonly settingsService: SettingsService,
    private readonly assuredLifecycleService: AssuredLifecycleService,
    private readonly assuredQueueService: AssuredQueueService,
    private readonly passengerDepositPenaltyService: PassengerAssuredDepositPenaltyService,
    private readonly configService: ConfigService,
    private readonly fareSettlementService: FareSettlementService,
  ) {}

  async cancelByPassenger(
    passengerId: string,
    bookingId: string,
  ): Promise<AssuredBookingLifecycleResponseDto> {
    return this.assuredLifecycleService.cancelBookingByRider(
      passengerId,
      bookingId,
    );
  }

  async payRegularPayLaterWithWallet(
    passengerId: string,
    bookingId: string,
  ): Promise<RegularPayLaterPaymentResponseDto> {
    try {
      const result = await this.dataSource.transaction((manager) =>
        this.fareSettlementService.settleRegularPayLaterWithWalletInTransaction(
          manager,
          passengerId,
          bookingId,
        ),
      );
      return this.toRegularPayLaterPaymentResponse(result);
    } catch (error) {
      this.rethrowWalletHttpErrors(error);
      throw error;
    }
  }

  async payRegularPayLaterWithCash(
    passengerId: string,
    bookingId: string,
  ): Promise<RegularPayLaterPaymentResponseDto> {
    try {
      const result = await this.dataSource.transaction((manager) =>
        this.fareSettlementService.settleRegularPayLaterWithCashInTransaction(
          manager,
          passengerId,
          bookingId,
        ),
      );
      return this.toRegularPayLaterPaymentResponse(result);
    } catch (error) {
      this.rethrowWalletHttpErrors(error);
      throw error;
    }
  }

  private toRegularPayLaterPaymentResponse(
    result: RegularPayLaterSettlementResult,
  ): RegularPayLaterPaymentResponseDto {
    return {
      bookingId: result.bookingId,
      fareAmount: result.fareAmount,
      paymentStatus: result.paymentStatus,
      passengerDebited: result.passengerDebited,
      driverCredited: result.driverCredited,
      paymentChannel: result.paymentChannel,
      alreadySettled: result.alreadySettled,
    };
  }

  async reportRiderNoShow(
    driverId: string,
    bookingId: string,
  ): Promise<AssuredBookingLifecycleResponseDto> {
    return this.assuredLifecycleService.reportRiderNoShow(driverId, bookingId);
  }

  /**
   * Driver verifies passenger pickup OTP for a trip-lifecycle ride booking.
   * Requires ride IN_PROGRESS and booking CONFIRMED + WAITING_FOR_PICKUP.
   */
  async verifyPickup(
    driverId: string,
    bookingId: string,
    dto: { otp: string },
  ): Promise<VerifyPickupResponseDto> {
    const otp = dto.otp?.trim() ?? '';
    if (!isValidPickupOtpFormat(otp)) {
      throw new BadRequestException('otp must be exactly 4 digits');
    }

    return this.dataSource.transaction(async (manager) => {
      const booking = await manager
        .getRepository(Booking)
        .createQueryBuilder('booking')
        .setLock('pessimistic_write')
        .where('booking.id = :bookingId', { bookingId })
        .getOne();

      if (!booking) {
        throw new NotFoundException('Booking not found');
      }

      const ride = await manager
        .getRepository(Ride)
        .createQueryBuilder('ride')
        .setLock('pessimistic_write')
        .where('ride.id = :rideId', { rideId: booking.rideId })
        .getOne();

      if (!ride || ride.driverId !== driverId) {
        throw new NotFoundException('Booking not found');
      }

      if (!supportsTripLifecycle(ride.rideType)) {
        throw new BadRequestException(
          'Pickup OTP verification applies only to trip-lifecycle rides',
        );
      }

      if (ride.status !== RideStatus.IN_PROGRESS) {
        throw new ConflictException(
          'Pickup can only be verified while the ride is in progress',
        );
      }

      if (booking.status === BookingStatus.CANCELLED) {
        throw new ConflictException('Cancelled bookings cannot be picked up');
      }

      if (booking.status !== BookingStatus.CONFIRMED) {
        throw new ConflictException(
          `Booking cannot be picked up from status ${booking.status}`,
        );
      }

      if (booking.pickupStatus === BookingPickupStatus.PICKED_UP) {
        return {
          bookingId: booking.id,
          rideId: booking.rideId,
          status: booking.status,
          pickupStatus: BookingPickupStatus.PICKED_UP,
          pickupVerifiedAt: booking.pickupVerifiedAt?.toISOString() ?? null,
          pickupOrder: booking.pickupOrder,
          alreadyVerified: true,
        };
      }

      await this.ensurePickupOtpMaterial(manager, booking, ride);

      if (
        booking.pickupOtpFailedAttempts >= PICKUP_OTP_MAX_ATTEMPTS
      ) {
        throw new ConflictException(
          'Pickup OTP locked after too many failed attempts',
        );
      }

      if (
        booking.pickupOtpExpiresAt &&
        booking.pickupOtpExpiresAt.getTime() <= Date.now()
      ) {
        throw new ConflictException('Pickup OTP has expired');
      }

      if (!booking.pickupOtpHash) {
        throw new ConflictException('Pickup OTP is not available for this booking');
      }

      const pepper = this.pickupOtpPepper();
      const candidate = hashPickupOtp(otp, booking.id, pepper);
      if (!pickupOtpHashesMatch(booking.pickupOtpHash, candidate)) {
        booking.pickupOtpFailedAttempts += 1;
        await manager.getRepository(Booking).save(booking);
        throw new BadRequestException('Invalid pickup OTP');
      }

      const now = new Date();
      booking.pickupStatus = BookingPickupStatus.PICKED_UP;
      booking.pickupVerifiedAt = now;
      booking.pickupOtpCiphertext = null;
      booking.pickupOtpFailedAttempts = 0;
      await manager.getRepository(Booking).save(booking);

      return {
        bookingId: booking.id,
        rideId: booking.rideId,
        status: booking.status,
        pickupStatus: BookingPickupStatus.PICKED_UP,
        pickupVerifiedAt: now.toISOString(),
        pickupOrder: booking.pickupOrder,
        alreadyVerified: false,
      };
    });
  }

  async create(
    passengerId: string,
    dto: CreateBookingDto,
    options: CreateBookingOptions = {},
  ): Promise<BookingResponseDto> {
    await this.assertPassengerCanBook(passengerId);
    this.assertFarePaymentCompatibility(dto);

    const ridePreview = await this.rideRepository.findOne({
      where: { id: dto.rideId },
      select: { id: true, rideType: true },
    });

    if (ridePreview?.rideType === RideType.COMMUTE) {
      if (dto.paymentMethod === BookingPaymentMethod.ASSURED_DEPOSIT) {
        throw new BadRequestException(
          'ASSURED_DEPOSIT is not valid for Commute rides',
        );
      }
      if (dto.farePayment !== undefined) {
        throw new BadRequestException(
          'farePayment is not allowed for Commute bookings',
        );
      }
      return this.createCommuteBooking(
        passengerId,
        dto,
        options.idempotencyKey,
      );
    }

    if (ridePreview?.rideType === RideType.ASSURED) {
      if (dto.paymentMethod === BookingPaymentMethod.ASSURED_DEPOSIT) {
        return this.createAssuredDepositBooking(
          passengerId,
          dto,
          options.idempotencyKey,
        );
      }
      if (
        dto.paymentMethod === BookingPaymentMethod.PAY_NOW ||
        dto.paymentMethod === BookingPaymentMethod.PAY_LATER
      ) {
        // Regular passenger booking on an Assured ride after half-time ALLOW.
        if (dto.paymentMethod === BookingPaymentMethod.PAY_NOW) {
          return this.createPayNow(passengerId, dto, options.idempotencyKey, {
            requireAssuredRegularOpen: true,
          });
        }
        return this.createPayLater(passengerId, dto, {
          requireAssuredRegularOpen: true,
        });
      }
      throw new BadRequestException('Invalid payment method');
    }

    if (dto.paymentMethod === BookingPaymentMethod.ASSURED_DEPOSIT) {
      throw new BadRequestException(
        'ASSURED_DEPOSIT is only valid for Assured rides',
      );
    }

    if (dto.paymentMethod === BookingPaymentMethod.PAY_NOW) {
      return this.createPayNow(passengerId, dto, options.idempotencyKey);
    }

    if (dto.paymentMethod === BookingPaymentMethod.PAY_LATER) {
      return this.createPayLater(passengerId, dto);
    }

    throw new BadRequestException('Invalid payment method');
  }

  async acceptCommuteBookingByDriver(
    driverId: string,
    bookingId: string,
  ): Promise<CommuteBookingDriverActionResponseDto> {
    return this.dataSource.transaction(async (manager) => {
      const bookingPeek = await manager.getRepository(Booking).findOne({
        where: { id: bookingId },
      });
      if (!bookingPeek) {
        throw new NotFoundException('Booking not found');
      }

      const ride = await this.lockRideForUpdate(manager, bookingPeek.rideId);
      if (ride.driverId !== driverId) {
        throw new NotFoundException('Booking not found');
      }

      if (ride.rideType !== RideType.COMMUTE) {
        throw new BadRequestException(
          'Accept applies only to Commute bookings',
        );
      }

      const booking = await this.lockBookingForUpdate(manager, bookingId);
      if (!booking) {
        throw new NotFoundException('Booking not found');
      }

      if (booking.bookingMode !== BookingMode.COMMUTE) {
        throw new BadRequestException(
          'Accept applies only to Commute bookings',
        );
      }

      if (booking.status === BookingStatus.CONFIRMED) {
        return this.toCommuteDriverActionResponse(
          booking,
          ride,
          null,
          true,
        );
      }

      if (booking.status !== BookingStatus.PENDING) {
        throw new ConflictException(
          `Booking cannot be accepted from status ${booking.status}`,
        );
      }

      this.assertCommuteRideAcceptable(ride);

      if (ride.availableSeats < booking.seats) {
        throw new ConflictException('Insufficient available seats');
      }

      ride.availableSeats -= booking.seats;
      await manager.getRepository(Ride).save(ride);

      booking.status = BookingStatus.CONFIRMED;
      await manager.getRepository(Booking).save(booking);

      return this.toCommuteDriverActionResponse(
        booking,
        ride,
        null,
        false,
      );
    });
  }

  async rejectCommuteBookingByDriver(
    driverId: string,
    bookingId: string,
  ): Promise<CommuteBookingDriverActionResponseDto> {
    const refundIdempotencyKey = `commute:reject:${bookingId}`;

    try {
      return await this.dataSource.transaction(async (manager) => {
        const bookingPeek = await manager.getRepository(Booking).findOne({
          where: { id: bookingId },
        });
        if (!bookingPeek) {
          throw new NotFoundException('Booking not found');
        }

        const ride = await this.lockRideForUpdate(manager, bookingPeek.rideId);
        if (ride.driverId !== driverId) {
          throw new NotFoundException('Booking not found');
        }

        if (ride.rideType !== RideType.COMMUTE) {
          throw new BadRequestException(
            'Reject applies only to Commute bookings',
          );
        }

        const booking = await this.lockBookingForUpdate(manager, bookingId);
        if (!booking) {
          throw new NotFoundException('Booking not found');
        }

        if (booking.bookingMode !== BookingMode.COMMUTE) {
          throw new BadRequestException(
            'Reject applies only to Commute bookings',
          );
        }

        if (booking.status === BookingStatus.CANCELLED) {
          if (
            booking.cancellationReason ===
            BookingCancellationReason.DRIVER_REJECTED
          ) {
            return this.toCommuteDriverActionResponse(
              booking,
              ride,
              null,
              true,
            );
          }
          throw new ConflictException(
            `Booking is already cancelled (${booking.cancellationReason})`,
          );
        }

        if (booking.status !== BookingStatus.PENDING) {
          throw new ConflictException(
            `Booking cannot be rejected from status ${booking.status}`,
          );
        }

        if (
          booking.paymentStatus === BookingPaymentStatus.PAID &&
          BigInt(booking.totalAmount) > 0n
        ) {
          const wallet = await this.lockWalletForUpdate(
            manager,
            booking.passengerId,
          );
          await this.walletService.creditPointsInTransaction(manager, {
            walletId: wallet.id,
            userId: booking.passengerId,
            amount: BigInt(booking.totalAmount),
            sourceType: WalletPointSource.PURCHASED,
            referenceType: 'BOOKING',
            referenceId: booking.id,
            idempotencyKey: refundIdempotencyKey,
            transactionType: WalletTransactionType.REFUND,
          });
        }

        const now = new Date();
        booking.status = BookingStatus.CANCELLED;
        booking.cancellationReason = BookingCancellationReason.DRIVER_REJECTED;
        booking.cancelledAt = now;
        await manager.getRepository(Booking).save(booking);

        return this.toCommuteDriverActionResponse(
          booking,
          ride,
          null,
          false,
        );
      });
    } catch (error) {
      if (this.walletService.isIdempotencyKeyConflict(error)) {
        const booking = await this.bookingRepository.findOne({
          where: { id: bookingId },
          relations: { ride: true },
        });
        if (
          booking &&
          booking.ride.driverId === driverId &&
          booking.status === BookingStatus.CANCELLED &&
          booking.cancellationReason ===
            BookingCancellationReason.DRIVER_REJECTED
        ) {
          return this.toCommuteDriverActionResponse(
            booking,
            booking.ride,
            null,
            true,
          );
        }
      }
      this.rethrowWalletHttpErrors(error);
      throw error;
    }
  }

  /**
   * farePayment is only valid with Assured ASSURED_DEPOSIT bookings.
   * Regular payment methods must not carry farePayment.
   */
  private assertFarePaymentCompatibility(dto: CreateBookingDto): void {
    if (dto.farePayment === undefined) {
      return;
    }
    if (dto.paymentMethod !== BookingPaymentMethod.ASSURED_DEPOSIT) {
      throw new BadRequestException(
        'farePayment is only allowed when paymentMethod is ASSURED_DEPOSIT',
      );
    }
  }

  private resolveAssuredFarePayment(
    dto: CreateBookingDto,
  ): BookingFarePayment {
    return dto.farePayment ?? BookingFarePayment.PAY_LATER;
  }

  private async createCommuteBooking(
    passengerId: string,
    dto: CreateBookingDto,
    idempotencyKey: string | null | undefined,
  ): Promise<BookingResponseDto> {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException(
        'Idempotency-Key header is required for Commute bookings',
      );
    }

    const key = idempotencyKey.trim();

    const existing = await this.bookingRepository.findOne({
      where: { idempotencyKey: key },
    });
    if (existing) {
      this.assertCommuteIdempotentRequestMatches(existing, passengerId, dto);
      const ride = await this.rideRepository.findOne({
        where: { id: existing.rideId },
      });
      return this.toResponseWithDriver(existing, ride ?? undefined);
    }

    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const ride = await this.lockRideForUpdate(manager, dto.rideId);
        this.assertCommuteRideBookable(ride, passengerId);
        this.assertCommuteRequestSeats(ride, dto.seats);
        await this.assertNoActiveBooking(manager, passengerId, ride.id);

        const existingAfterRideLock = await manager
          .getRepository(Booking)
          .findOne({ where: { idempotencyKey: key } });
        if (existingAfterRideLock) {
          this.assertCommuteIdempotentRequestMatches(
            existingAfterRideLock,
            passengerId,
            dto,
          );
          return { booking: existingAfterRideLock, ride };
        }

        const wallet = await this.lockWalletForUpdate(manager, passengerId);
        this.assertWalletAllowsPayment(wallet);

        const fare = computeCommuteBookingFareSnapshots(
          ride.pricePerSeat,
          dto.seats,
        );
        const amount = BigInt(fare.totalAmount);
        const bookingId = randomUUID();

        let walletTransactionId: string | null = null;
        if (amount > 0n) {
          const debit = await this.walletService.debitPointsInTransaction(
            manager,
            {
              walletId: wallet.id,
              userId: passengerId,
              amount,
              referenceType: 'BOOKING',
              referenceId: bookingId,
              idempotencyKey: key,
            },
          );
          walletTransactionId = debit.transaction.id;
        }

        const booking = manager.getRepository(Booking).create({
          id: bookingId,
          rideId: ride.id,
          passengerId,
          seats: dto.seats,
          status: BookingStatus.PENDING,
          paymentMethod: BookingPaymentMethod.PAY_NOW,
          paymentStatus: BookingPaymentStatus.PAID,
          farePaymentMethod: null,
          pricePerSeatSnapshot: fare.riderPricePerSeatSnapshot,
          totalAmount: fare.totalAmount,
          driverPricePerSeatSnapshot: fare.driverPricePerSeatSnapshot,
          riderPricePerSeatSnapshot: fare.riderPricePerSeatSnapshot,
          driverShareAmount: fare.driverShareAmount,
          platformShareAmount: fare.platformShareAmount,
          idempotencyKey: key,
          walletTransactionId,
          assuredDepositPercentage: null,
          assuredDepositAmount: null,
          walletHoldId: null,
          fareWalletTransactionId: null,
          bookingMode: BookingMode.COMMUTE,
          depositCouponId: null,
        });

        const saved = await manager.getRepository(Booking).save(booking);
        return { booking: saved, ride };
      });

      return this.toResponseWithDriver(result.booking, result.ride);
    } catch (error) {
      if (this.walletService.isIdempotencyKeyConflict(error)) {
        const recovered = await this.bookingRepository.findOne({
          where: { idempotencyKey: key },
        });
        if (recovered) {
          this.assertCommuteIdempotentRequestMatches(
            recovered,
            passengerId,
            dto,
          );
          const ride = await this.rideRepository.findOne({
            where: { id: recovered.rideId },
          });
          return this.toResponseWithDriver(recovered, ride ?? undefined);
        }
        throw new WalletOperationConflictError(
          'Idempotency conflict could not be resolved; existing booking not found',
        );
      }

      if (this.isBookingIdempotencyUniqueViolation(error)) {
        const recovered = await this.bookingRepository.findOne({
          where: { idempotencyKey: key },
        });
        if (recovered) {
          this.assertCommuteIdempotentRequestMatches(
            recovered,
            passengerId,
            dto,
          );
          const ride = await this.rideRepository.findOne({
            where: { id: recovered.rideId },
          });
          return this.toResponseWithDriver(recovered, ride ?? undefined);
        }
      }

      this.rethrowDuplicateActiveBooking(error);
      this.rethrowWalletHttpErrors(error);
      throw error;
    }
  }

  private async createPayLater(
    passengerId: string,
    dto: CreateBookingDto,
    options: { requireAssuredRegularOpen?: boolean } = {},
  ): Promise<BookingResponseDto> {
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const ride = await this.lockRideForUpdate(manager, dto.rideId);
        this.assertRideBookable(ride, passengerId);
        this.assertRegularBookingAllowedOnRide(
          ride,
          options.requireAssuredRegularOpen === true,
        );
        this.assertEnoughSeats(ride, dto.seats);
        await this.assertNoActiveBooking(manager, passengerId, ride.id);

        const pricePerSeatSnapshot = ride.pricePerSeat;
        const totalAmount = this.multiplyPoints(
          pricePerSeatSnapshot,
          dto.seats,
        );

        ride.availableSeats -= dto.seats;
        await manager.getRepository(Ride).save(ride);
        await this.maybeAdvanceAssuredQueueAfterBooking(manager, ride);

        const bookingId = randomUUID();
        const pickupFields = this.buildRegularPickupFields(
          ride,
          bookingId,
          manager,
        );

        const booking = manager.getRepository(Booking).create({
          id: bookingId,
          rideId: ride.id,
          passengerId,
          seats: dto.seats,
          status: BookingStatus.CONFIRMED,
          paymentMethod: BookingPaymentMethod.PAY_LATER,
          paymentStatus: BookingPaymentStatus.UNPAID,
          farePaymentMethod: null,
          pricePerSeatSnapshot,
          totalAmount,
          idempotencyKey: null,
          walletTransactionId: null,
          assuredDepositPercentage: null,
          assuredDepositAmount: null,
          walletHoldId: null,
          fareWalletTransactionId: null,
          bookingMode: BookingMode.REGULAR,
          depositCouponId: null,
          ...(await pickupFields),
        });

        const saved = await manager.getRepository(Booking).save(booking);
        return { booking: saved, ride };
      });
      return this.toResponseWithDriver(result.booking, result.ride);
    } catch (error) {
      this.rethrowDuplicateActiveBooking(error);
      throw error;
    }
  }

  private async createPayNow(
    passengerId: string,
    dto: CreateBookingDto,
    idempotencyKey: string | null | undefined,
    options: { requireAssuredRegularOpen?: boolean } = {},
  ): Promise<BookingResponseDto> {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException(
        'Idempotency-Key header is required for PAY_NOW bookings',
      );
    }

    const key = idempotencyKey.trim();

    const existing = await this.bookingRepository.findOne({
      where: { idempotencyKey: key },
    });
    if (existing) {
      this.assertIdempotentRequestMatches(existing, passengerId, dto);
      const ride = await this.rideRepository.findOne({
        where: { id: existing.rideId },
      });
      return this.toResponseWithDriver(existing, ride ?? undefined);
    }

    try {
      const result = await this.dataSource.transaction(async (manager) => {
        // Lock order: Ride → Wallet → WalletBalance → PointLots
        const ride = await this.lockRideForUpdate(manager, dto.rideId);
        this.assertRideBookable(ride, passengerId);
        this.assertRegularBookingAllowedOnRide(
          ride,
          options.requireAssuredRegularOpen === true,
        );
        this.assertEnoughSeats(ride, dto.seats);
        await this.assertNoActiveBooking(manager, passengerId, ride.id);

        const existingAfterRideLock = await manager
          .getRepository(Booking)
          .findOne({ where: { idempotencyKey: key } });
        if (existingAfterRideLock) {
          this.assertIdempotentRequestMatches(
            existingAfterRideLock,
            passengerId,
            dto,
          );
          return { booking: existingAfterRideLock, ride };
        }

        const wallet = await this.lockWalletForUpdate(manager, passengerId);
        this.assertWalletAllowsPayment(wallet);

        const pricePerSeatSnapshot = ride.pricePerSeat;
        const totalAmount = this.multiplyPoints(
          pricePerSeatSnapshot,
          dto.seats,
        );
        const amount = BigInt(totalAmount);
        const bookingId = randomUUID();

        let walletTransactionId: string | null = null;
        if (amount > 0n) {
          const debit = await this.walletService.debitPointsInTransaction(
            manager,
            {
              walletId: wallet.id,
              userId: passengerId,
              amount,
              referenceType: 'BOOKING',
              referenceId: bookingId,
              idempotencyKey: key,
            },
          );
          walletTransactionId = debit.transaction.id;
        }

        ride.availableSeats -= dto.seats;
        await manager.getRepository(Ride).save(ride);
        await this.maybeAdvanceAssuredQueueAfterBooking(manager, ride);

        const pickupFields = await this.buildRegularPickupFields(
          ride,
          bookingId,
          manager,
        );

        const booking = manager.getRepository(Booking).create({
          id: bookingId,
          rideId: ride.id,
          passengerId,
          seats: dto.seats,
          status: BookingStatus.CONFIRMED,
          paymentMethod: BookingPaymentMethod.PAY_NOW,
          paymentStatus: BookingPaymentStatus.PAID,
          farePaymentMethod: null,
          pricePerSeatSnapshot,
          totalAmount,
          idempotencyKey: key,
          walletTransactionId,
          assuredDepositPercentage: null,
          assuredDepositAmount: null,
          walletHoldId: null,
          fareWalletTransactionId: null,
          bookingMode: BookingMode.REGULAR,
          depositCouponId: null,
          ...pickupFields,
        });

        const saved = await manager.getRepository(Booking).save(booking);
        return { booking: saved, ride };
      });
      return this.toResponseWithDriver(result.booking, result.ride);
    } catch (error) {
      if (this.walletService.isIdempotencyKeyConflict(error)) {
        const recovered = await this.bookingRepository.findOne({
          where: { idempotencyKey: key },
        });
        if (recovered) {
          this.assertIdempotentRequestMatches(recovered, passengerId, dto);
          const ride = await this.rideRepository.findOne({
            where: { id: recovered.rideId },
          });
          return this.toResponseWithDriver(recovered, ride ?? undefined);
        }
        throw new WalletOperationConflictError(
          'Idempotency conflict could not be resolved; existing booking not found',
        );
      }

      if (this.isBookingIdempotencyUniqueViolation(error)) {
        const recovered = await this.bookingRepository.findOne({
          where: { idempotencyKey: key },
        });
        if (recovered) {
          this.assertIdempotentRequestMatches(recovered, passengerId, dto);
          const ride = await this.rideRepository.findOne({
            where: { id: recovered.rideId },
          });
          return this.toResponseWithDriver(recovered, ride ?? undefined);
        }
      }

      this.rethrowDuplicateActiveBooking(error);
      this.rethrowWalletHttpErrors(error);
      throw error;
    }
  }

  /**
   * Assured rider booking: mandatory security-deposit HOLD, optional fare debit.
   * ASSURED_DEPOSIT + PAY_LATER (default): hold only, fare UNPAID.
   * ASSURED_DEPOSIT + PAY_NOW: hold then fare debit in the same wallet TX.
   */
  private async createAssuredDepositBooking(
    passengerId: string,
    dto: CreateBookingDto,
    idempotencyKey: string | null | undefined,
  ): Promise<BookingResponseDto> {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException(
        'Idempotency-Key header is required for Assured bookings',
      );
    }

    const key = idempotencyKey.trim();
    const farePayment = this.resolveAssuredFarePayment(dto);

    const existing = await this.bookingRepository.findOne({
      where: { idempotencyKey: key },
    });
    if (existing) {
      this.assertIdempotentRequestMatches(existing, passengerId, dto);
      const ride = await this.rideRepository.findOne({
        where: { id: existing.rideId },
      });
      return this.toResponseWithDriver(existing, ride ?? undefined);
    }

    const percentage =
      await this.settingsService.getAssuredRideDepositPercentage();

    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const ride = await this.lockRideForUpdate(manager, dto.rideId);
        if (ride.rideType !== RideType.ASSURED) {
          throw new BadRequestException('Ride is not an Assured ride');
        }
        this.assertRideBookable(ride, passengerId);
        this.assertEnoughSeats(ride, dto.seats);
        await this.assertNoActiveBooking(manager, passengerId, ride.id);

        const existingAfterRideLock = await manager
          .getRepository(Booking)
          .findOne({ where: { idempotencyKey: key } });
        if (existingAfterRideLock) {
          this.assertIdempotentRequestMatches(
            existingAfterRideLock,
            passengerId,
            dto,
          );
          return { booking: existingAfterRideLock, ride };
        }

        const depositQuote =
          await this.passengerDepositPenaltyService.getDepositQuote(
            passengerId,
            manager,
          );
        const effectivePercentage = depositQuote.percentage;

        const wallet = await this.lockWalletForUpdate(manager, passengerId);
        this.assertWalletAllowsPayment(wallet);

        const pricePerSeatSnapshot = ride.pricePerSeat;
        const totalAmount = this.multiplyPoints(
          pricePerSeatSnapshot,
          dto.seats,
        );
        const fareAmount = BigInt(totalAmount);
        const bookingId = randomUUID();

        const coupon = await this.lockUnusedDepositCoupon(
          manager,
          passengerId,
        );
        let depositAmount = calculateRiderAssuredDeposit(
          dto.seats,
          BigInt(pricePerSeatSnapshot),
          effectivePercentage,
        );
        let depositCouponId: string | null = null;
        if (coupon) {
          depositAmount = 0n;
          depositCouponId = coupon.id;
          coupon.status = UserCouponStatus.USED;
          coupon.usedAt = new Date();
          coupon.usedBookingId = bookingId;
          await manager.getRepository(UserCoupon).save(coupon);
        }

        let walletHoldId: string | null = null;
        let walletTransactionId: string | null = null;
        if (depositAmount > 0n) {
          const holdResult = await this.walletService.createHoldInTransaction(
            manager,
            {
              walletId: wallet.id,
              amount: depositAmount,
              holdType: WalletHoldType.ASSURED_DEPOSIT,
              referenceType: ASSURED_BOOKING_RIDER_DEPOSIT_REF,
              referenceId: bookingId,
              idempotencyKey: key,
            },
          );
          walletHoldId = holdResult.hold!.id;
          walletTransactionId = holdResult.transaction.id;
        }

        let fareWalletTransactionId: string | null = null;
        let paymentStatus = BookingPaymentStatus.UNPAID;
        if (farePayment === BookingFarePayment.PAY_NOW) {
          if (fareAmount > 0n) {
            const debit = await this.walletService.debitPointsInTransaction(
              manager,
              {
                walletId: wallet.id,
                userId: passengerId,
                amount: fareAmount,
                referenceType: 'BOOKING',
                referenceId: bookingId,
                // Distinct from deposit hold key (unique wallet ledger constraint).
                idempotencyKey: `${key}:fare`,
              },
            );
            fareWalletTransactionId = debit.transaction.id;
          }
          paymentStatus = BookingPaymentStatus.PAID;
        }

        ride.availableSeats -= dto.seats;
        await manager.getRepository(Ride).save(ride);
        await this.maybeAdvanceAssuredQueueAfterBooking(manager, ride);

        const booking = manager.getRepository(Booking).create({
          id: bookingId,
          rideId: ride.id,
          passengerId,
          seats: dto.seats,
          status: BookingStatus.CONFIRMED,
          paymentMethod: BookingPaymentMethod.ASSURED_DEPOSIT,
          paymentStatus,
          farePaymentMethod: farePayment,
          pricePerSeatSnapshot,
          totalAmount,
          idempotencyKey: key,
          walletTransactionId,
          assuredDepositPercentage: effectivePercentage,
          assuredDepositReason: depositQuote.reason,
          assuredDepositAmount: depositAmount.toString(),
          walletHoldId,
          fareWalletTransactionId,
          bookingMode: BookingMode.ASSURED,
          depositCouponId,
        });

        const saved = await manager.getRepository(Booking).save(booking);
        if (
          depositQuote.elevated &&
          depositQuote.reason === SECURITY_DEPOSIT_REASON_PREVIOUS_CANCELLATION
        ) {
          await this.passengerDepositPenaltyService.markConsumedOnBooking(
            manager,
            passengerId,
            saved.id,
          );
        }
        return { booking: saved, ride };
      });
      return this.toResponseWithDriver(result.booking, result.ride);
    } catch (error) {
      if (this.walletService.isIdempotencyKeyConflict(error)) {
        const recovered = await this.bookingRepository.findOne({
          where: { idempotencyKey: key },
        });
        if (recovered) {
          this.assertIdempotentRequestMatches(recovered, passengerId, dto);
          const ride = await this.rideRepository.findOne({
            where: { id: recovered.rideId },
          });
          return this.toResponseWithDriver(recovered, ride ?? undefined);
        }
        throw new WalletOperationConflictError(
          'Idempotency conflict could not be resolved; existing booking not found',
        );
      }

      if (this.isBookingIdempotencyUniqueViolation(error)) {
        const recovered = await this.bookingRepository.findOne({
          where: { idempotencyKey: key },
        });
        if (recovered) {
          this.assertIdempotentRequestMatches(recovered, passengerId, dto);
          const ride = await this.rideRepository.findOne({
            where: { id: recovered.rideId },
          });
          return this.toResponseWithDriver(recovered, ride ?? undefined);
        }
      }

      this.rethrowDuplicateActiveBooking(error);
      this.rethrowWalletHttpErrors(error);
      throw error;
    }
  }

  private async lockUnusedDepositCoupon(
    manager: EntityManager,
    userId: string,
  ): Promise<UserCoupon | null> {
    return manager
      .getRepository(UserCoupon)
      .createQueryBuilder('coupon')
      .setLock('pessimistic_write')
      .where('coupon.user_id = :userId', { userId })
      .andWhere('coupon.coupon_type = :type', {
        type: UserCouponType.NEXT_ASSURED_DEPOSIT_FREE,
      })
      .andWhere('coupon.status = :status', { status: UserCouponStatus.UNUSED })
      .orderBy('coupon.created_at', 'ASC')
      .addOrderBy('coupon.id', 'ASC')
      .getOne();
  }

  private assertRegularBookingAllowedOnRide(
    ride: Ride,
    requireAssuredRegularOpen: boolean,
  ): void {
    if (!requireAssuredRegularOpen) {
      if (ride.rideType === RideType.ASSURED) {
        throw new ConflictException(
          'Regular payment methods are not allowed on Assured rides unless the driver opens remaining seats',
        );
      }
      return;
    }

    if (ride.rideType !== RideType.ASSURED) {
      throw new BadRequestException('Ride is not an Assured ride');
    }

    if (
      ride.regularSeatsPolicy !== RegularSeatsPolicy.ALLOW_REGULAR_RIDERS
    ) {
      throw new ConflictException(
        'Regular riders cannot book this Assured ride until the driver chooses ALLOW_REGULAR_RIDERS',
      );
    }
  }

  async findMine(passengerId: string): Promise<BookingResponseDto[]> {
    const bookings = await this.bookingRepository.find({
      where: { passengerId },
      order: { createdAt: 'DESC' },
    });

    if (bookings.length === 0) {
      return [];
    }

    const rideIds = [...new Set(bookings.map((booking) => booking.rideId))];
    const rides = await this.rideRepository.find({
      where: { id: In(rideIds) },
    });
    const rideById = new Map(rides.map((ride) => [ride.id, ride] as const));
    const driverById = await this.resolveDrivers(
      rides.map((ride) => ride.driverId),
    );
    const vehicleById = await this.resolveVehicles(
      rides.map((ride) => ride.vehicleId),
    );

    const hydrated: Booking[] = [];
    for (const booking of bookings) {
      const ride = rideById.get(booking.rideId);
      if (ride) {
        await this.dataSource.transaction((manager) =>
          this.ensurePickupOtpMaterial(manager, booking, ride),
        );
      }
      hydrated.push(booking);
    }

    return hydrated.map((booking) => {
      const ride = rideById.get(booking.rideId);
      return this.toResponse(
        booking,
        ride,
        ride ? driverById.get(ride.driverId) : undefined,
        ride ? vehicleById.get(ride.vehicleId) : undefined,
      );
    });
  }

  /**
   * Paginated past bookings for the authenticated passenger
   * (COMPLETED / CANCELLED only).
   */
  async findHistory(
    passengerId: string,
    query: BookingHistoryQueryDto,
  ): Promise<BookingHistoryPageDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const statuses = query.status
      ? [query.status]
      : [BookingStatus.COMPLETED, BookingStatus.CANCELLED];

    const qb = this.bookingRepository
      .createQueryBuilder('booking')
      .where('booking.passenger_id = :passengerId', { passengerId })
      .andWhere('booking.status IN (:...statuses)', { statuses })
      .orderBy('booking.created_at', 'DESC')
      .addOrderBy('booking.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [bookings, total] = await qb.getManyAndCount();
    const items = await this.toHistoryListItems(bookings);

    return {
      items,
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /**
   * Passenger past-booking detail with driver/vehicle/fare from real data.
   */
  async findHistoryDetail(
    passengerId: string,
    bookingId: string,
  ): Promise<BookingHistoryDetailDto> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
    });
    if (
      !booking ||
      (booking.status !== BookingStatus.COMPLETED &&
        booking.status !== BookingStatus.CANCELLED)
    ) {
      throw new NotFoundException('Booking not found');
    }

    const [item] = await this.toHistoryListItems([booking]);
    if (!item) {
      throw new NotFoundException('Booking not found');
    }

    return {
      trip: item.trip,
      driver: item.driver,
      vehicle: item.vehicle,
      fare: item.fare,
      payment: {
        paymentMethod: booking.paymentMethod,
        paymentStatus: booking.paymentStatus,
        transactionId: booking.walletTransactionId,
      },
      invoice: {
        invoiceId: null,
        invoiceDate: null,
        paymentReference: booking.walletTransactionId,
      },
      bookedAt: item.bookedAt,
    };
  }

  async findOne(
    passengerId: string,
    bookingId: string,
  ): Promise<BookingResponseDto> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, passengerId },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    const ride = await this.rideRepository.findOne({
      where: { id: booking.rideId },
    });

    if (ride) {
      await this.dataSource.transaction((manager) =>
        this.ensurePickupOtpMaterial(manager, booking, ride),
      );
    }

    const [driverById, vehicleById] =
      ride != null
        ? await Promise.all([
            this.resolveDrivers([ride.driverId]),
            this.resolveVehicles([ride.vehicleId]),
          ])
        : [new Map<string, BookingDriverDto>(), new Map<string, BookingVehicleSnapshotDto>()];

    const coPassengers = await this.resolveCoPassengers(
      booking.rideId,
      booking.passengerId,
    );

    return this.toResponse(
      booking,
      ride ?? undefined,
      ride != null ? driverById.get(ride.driverId) : undefined,
      ride != null ? vehicleById.get(ride.vehicleId) : undefined,
      coPassengers,
    );
  }

  /**
   * Driver-facing booking list for rides owned by the authenticated driver.
   * Authorization is JWT-only (driverId never accepted from the client).
   * Read-only: no wallet, hold, seat, or booking mutations.
   */
  async findForDriverRides(
    driverId: string,
    query: DriverBookingsQueryDto,
  ): Promise<DriverBookingPageDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    if (query.rideId) {
      const ownedRide = await this.rideRepository.findOne({
        where: { id: query.rideId, driverId },
      });
      if (!ownedRide) {
        throw new NotFoundException('Ride not found');
      }
    }

    const qb = this.bookingRepository
      .createQueryBuilder('booking')
      .innerJoinAndSelect('booking.ride', 'ride')
      .where('ride.driver_id = :driverId', { driverId });

    if (query.rideId) {
      qb.andWhere('booking.ride_id = :rideId', { rideId: query.rideId });
    }

    if (query.status) {
      qb.andWhere('booking.status = :status', { status: query.status });
    }

    if (query.rideId) {
      // Sequential pickup queue: earliest confirmed first.
      qb.orderBy('booking.pickup_order', 'ASC', 'NULLS LAST')
        .addOrderBy('booking.created_at', 'ASC')
        .addOrderBy('booking.id', 'ASC');
    } else {
      qb.orderBy('booking.created_at', 'DESC').addOrderBy('booking.id', 'DESC');
    }

    const [bookings, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

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

    const items: DriverBookingItemDto[] = bookings.map((booking) =>
      this.toDriverBookingItem(
        booking,
        booking.ride,
        profileByUserId.get(booking.passengerId) ?? null,
      ),
    );

    return {
      items,
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  private async assertPassengerCanBook(passengerId: string): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id: passengerId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const eligibility = await this.verificationService.canBookRide(passengerId);
    if (!eligibility.allowed) {
      throw new ForbiddenException(
        'Identity verification is required before booking a ride',
      );
    }
  }

  private async lockRideForUpdate(
    manager: EntityManager,
    rideId: string,
  ): Promise<Ride> {
    const ride = await manager
      .getRepository(Ride)
      .createQueryBuilder('ride')
      .setLock('pessimistic_write')
      .where('ride.id = :rideId', { rideId })
      .getOne();

    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    return ride;
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

  private assertWalletAllowsPayment(wallet: Wallet): void {
    if (wallet.status === WalletStatus.SUSPENDED) {
      throw new ForbiddenException('Wallet is suspended');
    }
    if (wallet.status === WalletStatus.LOCKED) {
      throw new ForbiddenException('Wallet is locked');
    }
  }

  private assertRideBookable(ride: Ride, passengerId: string): void {
    if (ride.rideType === RideType.COMMUTE) {
      if (!isCommutePublishedStatus(ride.status)) {
        throw new BadRequestException('Only published Commute rides can be booked');
      }
    } else if (ride.rideType === RideType.ASSURED) {
      if (!isAssuredBookableStatus(ride.status)) {
        throw new BadRequestException('Only active Assured rides can be booked');
      }
    } else if (!isRegularPublishedStatus(ride.status)) {
      throw new BadRequestException('Only published rides can be booked');
    }

    if (ride.driverId === passengerId) {
      throw new ForbiddenException('Drivers cannot book their own ride');
    }
  }

  private assertCommuteRideBookable(ride: Ride, passengerId: string): void {
    if (ride.rideType !== RideType.COMMUTE) {
      throw new BadRequestException('Ride is not a Commute ride');
    }
    if (!isCommutePublishedStatus(ride.status)) {
      throw new BadRequestException('Only published Commute rides can be booked');
    }
    if (ride.driverId === passengerId) {
      throw new ForbiddenException('Drivers cannot book their own ride');
    }
  }

  private assertCommuteRideAcceptable(ride: Ride): void {
    if (ride.rideType !== RideType.COMMUTE) {
      throw new BadRequestException('Ride is not a Commute ride');
    }
    if (!isCommutePublishedStatus(ride.status)) {
      throw new ConflictException('Commute ride is no longer available');
    }
    if (ride.status === RideStatus.CANCELLED) {
      throw new ConflictException('Commute ride is cancelled');
    }
  }

  private assertCommuteRequestSeats(ride: Ride, seats: number): void {
    if (seats > ride.totalSeats) {
      throw new BadRequestException(
        'Requested seats exceed the ride total capacity',
      );
    }
  }

  private assertCommuteIdempotentRequestMatches(
    existing: Booking,
    passengerId: string,
    dto: CreateBookingDto,
  ): void {
    if (existing.bookingMode !== BookingMode.COMMUTE) {
      throw new ConflictException(
        'Idempotency key was reused for a different booking request',
      );
    }
    if (
      existing.passengerId !== passengerId ||
      existing.rideId !== dto.rideId ||
      existing.seats !== dto.seats
    ) {
      throw new ConflictException(
        'Idempotency key was reused for a different booking request',
      );
    }
  }

  private async lockBookingForUpdate(
    manager: EntityManager,
    bookingId: string,
  ): Promise<Booking | null> {
    return manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .setLock('pessimistic_write')
      .where('booking.id = :bookingId', { bookingId })
      .getOne();
  }

  private async toCommuteDriverActionResponse(
    booking: Booking,
    ride: Ride,
    profile: UserProfile | null,
    alreadyApplied: boolean,
  ): Promise<CommuteBookingDriverActionResponseDto> {
    if (!profile) {
      const loaded = await this.userProfileRepository.findOne({
        where: { userId: booking.passengerId },
      });
      profile = loaded;
    }
    return {
      ...this.toDriverBookingItem(booking, ride, profile),
      alreadyApplied,
    };
  }

  private async maybeAdvanceAssuredQueueAfterBooking(
    manager: EntityManager,
    ride: Ride,
  ): Promise<void> {
    if (ride.rideType !== RideType.ASSURED || ride.availableSeats > 0) {
      return;
    }
    await this.assuredQueueService.handleRideBecameFullInTransaction(
      manager,
      ride,
    );
  }

  private assertEnoughSeats(ride: Ride, seats: number): void {
    if (ride.availableSeats < seats) {
      throw new ConflictException('Insufficient available seats');
    }
  }

  private async assertNoActiveBooking(
    manager: EntityManager,
    passengerId: string,
    rideId: string,
  ): Promise<void> {
    const existingActive = await manager.getRepository(Booking).findOne({
      where: {
        passengerId,
        rideId,
        status: In([BookingStatus.PENDING, BookingStatus.CONFIRMED]),
      },
    });
    if (existingActive) {
      throw new ConflictException(
        'An active booking already exists for this ride',
      );
    }
  }

  private assertIdempotentRequestMatches(
    existing: Booking,
    passengerId: string,
    dto: CreateBookingDto,
  ): void {
    if (
      existing.passengerId !== passengerId ||
      existing.rideId !== dto.rideId ||
      existing.seats !== dto.seats ||
      existing.paymentMethod !== dto.paymentMethod
    ) {
      throw new ConflictException(
        'Idempotency key was reused for a different booking request',
      );
    }

    if (dto.paymentMethod === BookingPaymentMethod.ASSURED_DEPOSIT) {
      const requestedFare = this.resolveAssuredFarePayment(dto);
      const existingFare =
        existing.farePaymentMethod ?? BookingFarePayment.PAY_LATER;
      if (existingFare !== requestedFare) {
        throw new ConflictException(
          'Idempotency key was reused for a different Assured farePayment choice',
        );
      }
    } else if (dto.farePayment !== undefined) {
      throw new ConflictException(
        'Idempotency key was reused for a different booking request',
      );
    }
  }

  private multiplyPoints(pricePerSeat: string, seats: number): string {
    return (BigInt(pricePerSeat) * BigInt(seats)).toString();
  }

  private resolveSecurityDepositStatus(
    booking: Booking,
  ): 'HELD' | 'NONE' | null {
    if (booking.bookingMode !== BookingMode.ASSURED) {
      return null;
    }
    if (booking.walletHoldId) {
      return 'HELD';
    }
    return 'NONE';
  }

  private async toResponseWithDriver(
    booking: Booking,
    ride?: Ride,
  ): Promise<BookingResponseDto> {
    if (ride == null) {
      return this.toResponse(booking, ride);
    }

    const [driverById, vehicleById] = await Promise.all([
      this.resolveDrivers([ride.driverId]),
      this.resolveVehicles([ride.vehicleId]),
    ]);

    return this.toResponse(
      booking,
      ride,
      driverById.get(ride.driverId),
      vehicleById.get(ride.vehicleId),
    );
  }

  /** Other active passengers on the same ride; excludes the requesting passenger. */
  private async resolveCoPassengers(
    rideId: string,
    excludePassengerId: string,
  ): Promise<BookingCoPassengerDto[]> {
    const peerBookings = await this.bookingRepository.find({
      where: {
        rideId,
        status: In([BookingStatus.PENDING, BookingStatus.CONFIRMED]),
      },
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    const others = peerBookings.filter(
      (peer) => peer.passengerId !== excludePassengerId,
    );
    if (others.length === 0) {
      return [];
    }

    const passengerIds = [...new Set(others.map((peer) => peer.passengerId))];
    const profiles = await this.userProfileRepository.find({
      where: { userId: In(passengerIds) },
    });
    const profileByUserId = new Map(
      profiles.map((profile) => [profile.userId, profile] as const),
    );

    return others.map((peer) => {
      const profile = profileByUserId.get(peer.passengerId);
      return {
        passengerId: peer.passengerId,
        displayName: profile?.displayName ?? profile?.firstName ?? null,
        profilePhoto: profile?.profilePhoto ?? null,
        seats: peer.seats,
      };
    });
  }

  private async resolveDrivers(
    driverIds: string[],
  ): Promise<Map<string, BookingDriverDto>> {
    const uniqueIds = [...new Set(driverIds.filter(Boolean))];
    const result = new Map<string, BookingDriverDto>();

    if (uniqueIds.length === 0) {
      return result;
    }

    const [profiles, identityRows] = await Promise.all([
      this.userProfileRepository.find({
        where: { userId: In(uniqueIds) },
      }),
      this.verificationRepository.find({
        where: {
          userId: In(uniqueIds),
          verificationType: VerificationType.IDENTITY,
          isCurrent: true,
        },
      }),
    ]);

    const profileByUserId = new Map(
      profiles.map((profile) => [profile.userId, profile] as const),
    );
    const identityByUserId = new Map(
      identityRows.map((row) => [row.userId, row] as const),
    );

    for (const driverId of uniqueIds) {
      const profile = profileByUserId.get(driverId);
      const identity = identityByUserId.get(driverId);
      result.set(driverId, {
        id: driverId,
        displayName: profile?.displayName ?? profile?.firstName ?? null,
        profilePhoto: profile?.profilePhoto ?? null,
        isVerified: this.isIdentityCurrentlyVerified(identity),
      });
    }

    return result;
  }

  private async resolveVehicles(
    vehicleIds: string[],
  ): Promise<Map<string, BookingVehicleSnapshotDto>> {
    const uniqueIds = [...new Set(vehicleIds.filter(Boolean))];
    const result = new Map<string, BookingVehicleSnapshotDto>();

    if (uniqueIds.length === 0) {
      return result;
    }

    const vehicles = await this.vehicleRepository.find({
      where: { id: In(uniqueIds) },
      withDeleted: true,
    });

    for (const vehicle of vehicles) {
      result.set(vehicle.id, {
        make: vehicle.make,
        model: vehicle.model,
        color: vehicle.color,
        registrationNumber: vehicle.registrationNumber,
      });
    }

    return result;
  }

  private async toHistoryListItems(
    bookings: Booking[],
  ): Promise<BookingHistoryListItemDto[]> {
    if (bookings.length === 0) {
      return [];
    }

    const rideIds = [...new Set(bookings.map((booking) => booking.rideId))];
    const rides = await this.rideRepository.find({
      where: { id: In(rideIds) },
    });
    const rideById = new Map(rides.map((ride) => [ride.id, ride] as const));

    const driverById = await this.resolveDrivers(
      rides.map((ride) => ride.driverId),
    );

    const vehicleIds = [...new Set(rides.map((ride) => ride.vehicleId))];
    const vehicles =
      vehicleIds.length === 0
        ? []
        : await this.vehicleRepository.find({
            where: { id: In(vehicleIds) },
            withDeleted: true,
          });
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

    return bookings.map((booking) => {
      const ride = rideById.get(booking.rideId);
      const driver = ride ? driverById.get(ride.driverId) : undefined;
      const vehicle = ride ? vehicleById.get(ride.vehicleId) : undefined;

      return {
        trip: this.toHistoryTrip(booking, ride),
        driver: driver
          ? ({
              id: driver.id,
              name: driver.displayName,
              profileImage: driver.profilePhoto,
              isVerified: driver.isVerified,
            } satisfies BookingHistoryDriverDto)
          : null,
        vehicle: vehicle
          ? ({
              id: vehicle.id,
              name: `${vehicle.make} ${vehicle.model}`.trim(),
              make: vehicle.make,
              model: vehicle.model,
              color: vehicle.color,
              registrationNumber: vehicle.registrationNumber,
              isVerified:
                vehicleVerifiedByUserId.get(vehicle.userId) === true,
            } satisfies BookingHistoryVehicleDto)
          : null,
        fare: this.toHistoryFare(booking),
        bookedAt: booking.createdAt.toISOString(),
      };
    });
  }

  private toHistoryTrip(
    booking: Booking,
    ride: Ride | undefined,
  ): BookingHistoryTripDto {
    return {
      bookingId: booking.id,
      rideId: booking.rideId,
      bookingStatus: booking.status,
      rideStatus: ride?.status ?? RideStatus.CANCELLED,
      rideType: ride?.rideType ?? RideType.REGULAR,
      source: ride?.source ?? '',
      destination: ride?.destination ?? '',
      sourceLatitude: null,
      sourceLongitude: null,
      destinationLatitude: null,
      destinationLongitude: null,
      departureDate: ride
        ? String(ride.departureDate).slice(0, 10)
        : '',
      departureTime: ride
        ? ride.departureTime.length >= 8
          ? ride.departureTime.slice(0, 8)
          : ride.departureTime
        : '',
      pickedUpAt: booking.pickupVerifiedAt?.toISOString() ?? null,
      droppedOffAt: null,
      durationMinutes: null,
      distanceKm: null,
      pickupStatus: booking.pickupStatus,
      seats: booking.seats,
    };
  }

  private toHistoryFare(booking: Booking): BookingHistoryFareBreakdownDto {
    return {
      rideFare: booking.totalAmount,
      platformFee: null,
      taxes: null,
      promoDiscount: null,
      securityDeposit: booking.assuredDepositAmount,
      otherCharges: null,
      totalPaid:
        booking.paymentStatus === BookingPaymentStatus.PAID
          ? booking.totalAmount
          : '0',
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
    booking: Booking,
    ride?: Ride,
    driver?: BookingDriverDto,
    vehicle?: BookingVehicleSnapshotDto,
    coPassengers?: BookingCoPassengerDto[],
  ): BookingResponseDto {
    const includeOtp =
      booking.pickupStatus === BookingPickupStatus.WAITING_FOR_PICKUP &&
      Boolean(booking.pickupOtpCiphertext);

    return {
      id: booking.id,
      rideId: booking.rideId,
      passengerId: booking.passengerId,
      seats: booking.seats,
      status: booking.status,
      paymentMethod: booking.paymentMethod,
      paymentStatus: booking.paymentStatus,
      farePayment: booking.farePaymentMethod,
      farePaymentStatus: booking.paymentStatus,
      fareAmount: booking.totalAmount,
      pricePerSeatSnapshot: booking.pricePerSeatSnapshot,
      totalAmount: booking.totalAmount,
      ...(booking.bookingMode === BookingMode.COMMUTE
        ? {
            riderPricePerSeatSnapshot: booking.riderPricePerSeatSnapshot,
            driverPricePerSeatSnapshot: booking.driverPricePerSeatSnapshot,
            driverShareAmount: booking.driverShareAmount,
            platformShareAmount: booking.platformShareAmount,
          }
        : {}),
      securityDepositAmount: booking.assuredDepositAmount,
      securityDepositPercentage: booking.assuredDepositPercentage,
      securityDepositReason: booking.assuredDepositReason,
      securityDepositStatus: this.resolveSecurityDepositStatus(booking),
      bookingMode: booking.bookingMode,
      pickupStatus: booking.pickupStatus,
      pickupOtp: includeOtp
        ? decryptPickupOtp(booking.pickupOtpCiphertext!, this.pickupOtpPepper())
        : null,
      pickupVerifiedAt: booking.pickupVerifiedAt?.toISOString() ?? null,
      pickupOrder: booking.pickupOrder,
      ride: ride
        ? {
            id: ride.id,
            rideType: ride.rideType,
            status: ride.status,
            source: ride.source,
            destination: ride.destination,
            departureDate: ride.departureDate,
            departureTime:
              ride.departureTime.length >= 8
                ? ride.departureTime.slice(0, 8)
                : ride.departureTime,
          }
        : undefined,
      driver,
      vehicle,
      ...(coPassengers !== undefined ? { coPassengers } : {}),
      createdAt: booking.createdAt.toISOString(),
      updatedAt: booking.updatedAt.toISOString(),
    };
  }

  private toDriverBookingItem(
    booking: Booking,
    ride: Ride,
    profile: UserProfile | null,
  ): DriverBookingItemDto {
    return {
      id: booking.id,
      rideId: booking.rideId,
      passenger: {
        id: booking.passengerId,
        firstName: profile?.firstName ?? null,
        lastName: profile?.lastName ?? null,
        displayName: profile?.displayName ?? null,
        profilePhoto: profile?.profilePhoto ?? null,
      },
      seats: booking.seats,
      status: booking.status,
      pickupStatus: booking.pickupStatus,
      pickupVerifiedAt: booking.pickupVerifiedAt?.toISOString() ?? null,
      pickupOrder: booking.pickupOrder,
      bookingMode: booking.bookingMode,
      paymentMethod: booking.paymentMethod,
      paymentStatus: booking.paymentStatus,
      pricePerSeatSnapshot: booking.pricePerSeatSnapshot,
      totalAmount: booking.totalAmount,
      ...(booking.bookingMode === BookingMode.COMMUTE
        ? {
            riderPricePerSeatSnapshot: booking.riderPricePerSeatSnapshot,
            driverPricePerSeatSnapshot: booking.driverPricePerSeatSnapshot,
            driverShareAmount: booking.driverShareAmount,
            platformShareAmount: booking.platformShareAmount,
          }
        : {}),
      ride: {
        id: ride.id,
        source: ride.source,
        destination: ride.destination,
        departureDate: ride.departureDate,
        departureTime:
          ride.departureTime.length >= 8
            ? ride.departureTime.slice(0, 8)
            : ride.departureTime,
        rideType: ride.rideType,
        status: ride.status,
      },
      createdAt: booking.createdAt.toISOString(),
      updatedAt: booking.updatedAt.toISOString(),
    };
  }

  private pickupOtpPepper(): string {
    const secret =
      this.configService.get<string>('JWT_ACCESS_SECRET') ??
      this.configService.get<string>('PICKUP_OTP_SECRET');
    if (!secret || secret.trim().length < 8) {
      throw new Error('JWT_ACCESS_SECRET is required for pickup OTP');
    }
    return secret.trim();
  }

  private async buildRegularPickupFields(
    ride: Ride,
    bookingId: string,
    manager: EntityManager,
  ): Promise<
    Partial<
      Pick<
        Booking,
        | 'pickupOtpHash'
        | 'pickupOtpCiphertext'
        | 'pickupStatus'
        | 'pickupVerifiedAt'
        | 'pickupOtpFailedAttempts'
        | 'pickupOtpExpiresAt'
        | 'pickupOrder'
      >
    >
  > {
    if (!supportsTripLifecycle(ride.rideType)) {
      return {
        pickupOtpHash: null,
        pickupOtpCiphertext: null,
        pickupStatus: null,
        pickupVerifiedAt: null,
        pickupOtpFailedAttempts: 0,
        pickupOtpExpiresAt: null,
        pickupOrder: null,
      };
    }

    const pepper = this.pickupOtpPepper();
    const otp = generatePickupOtp();
    const maxOrder = await manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .select('MAX(booking.pickup_order)', 'max')
      .where('booking.ride_id = :rideId', { rideId: ride.id })
      .getRawOne<{ max: string | null }>();

    const nextOrder = Number(maxOrder?.max ?? 0) + 1;

    return {
      pickupOtpHash: hashPickupOtp(otp, bookingId, pepper),
      pickupOtpCiphertext: encryptPickupOtp(otp, pepper),
      pickupStatus: BookingPickupStatus.WAITING_FOR_PICKUP,
      pickupVerifiedAt: null,
      pickupOtpFailedAttempts: 0,
      pickupOtpExpiresAt: new Date(Date.now() + PICKUP_OTP_TTL_MS),
      pickupOrder: nextOrder,
    };
  }

  /**
   * Backfill OTP material for legacy trip-lifecycle bookings created before this feature.
   */
  async ensurePickupOtpMaterial(
    manager: EntityManager,
    booking: Booking,
    ride: Ride,
  ): Promise<void> {
    if (!supportsTripLifecycle(ride.rideType)) {
      return;
    }
    if (
      booking.status !== BookingStatus.PENDING &&
      booking.status !== BookingStatus.CONFIRMED
    ) {
      return;
    }
    if (booking.pickupStatus === BookingPickupStatus.PICKED_UP) {
      return;
    }
    if (booking.pickupOtpHash && booking.pickupOtpCiphertext) {
      if (!booking.pickupStatus) {
        booking.pickupStatus = BookingPickupStatus.WAITING_FOR_PICKUP;
        await manager.getRepository(Booking).save(booking);
      }
      return;
    }

    const fields = await this.buildRegularPickupFields(
      ride,
      booking.id,
      manager,
    );
    Object.assign(booking, fields);
    if (!booking.pickupOrder) {
      booking.pickupOrder = fields.pickupOrder ?? 1;
    }
    await manager.getRepository(Booking).save(booking);
  }

  /**
   * Called when starting a trip-lifecycle ride: ensure every active booking has OTP material.
   */
  async ensurePickupOtpsForRideStart(
    manager: EntityManager,
    ride: Ride,
  ): Promise<void> {
    if (!supportsTripLifecycle(ride.rideType)) {
      return;
    }
    const bookings = await manager.getRepository(Booking).find({
      where: {
        rideId: ride.id,
        status: In([BookingStatus.PENDING, BookingStatus.CONFIRMED]),
      },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    for (const booking of bookings) {
      await this.ensurePickupOtpMaterial(manager, booking, ride);
    }
  }

  private rethrowDuplicateActiveBooking(error: unknown): void {
    if (
      error instanceof QueryFailedError &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    ) {
      const constraint =
        (error as { constraint?: string }).constraint ??
        (
          error as { driverError?: { constraint?: string } }
        ).driverError?.constraint;
      if (
        constraint === 'UQ_bookings_active_passenger_ride' ||
        constraint?.includes('active_passenger_ride')
      ) {
        throw new ConflictException(
          'An active booking already exists for this ride',
        );
      }
    }
  }

  private isBookingIdempotencyUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const code =
      (error as { code?: string }).code ??
      (error.driverError as { code?: string } | undefined)?.code;
    const constraint =
      (error as { constraint?: string }).constraint ??
      (error.driverError as { constraint?: string } | undefined)?.constraint;
    return (
      code === '23505' &&
      (constraint === 'UQ_bookings_idempotency_key' ||
        Boolean(constraint?.includes('idempotency_key')))
    );
  }

  private rethrowWalletHttpErrors(error: unknown): void {
    if (
      error instanceof InsufficientWalletBalanceError ||
      error instanceof WalletNotFoundError ||
      error instanceof WalletBalanceNotFoundError ||
      error instanceof WalletOperationConflictError ||
      error instanceof PlatformWalletForbiddenError ||
      error instanceof ForbiddenException ||
      error instanceof BadRequestException ||
      error instanceof ConflictException ||
      error instanceof NotFoundException
    ) {
      throw error;
    }
  }
}
