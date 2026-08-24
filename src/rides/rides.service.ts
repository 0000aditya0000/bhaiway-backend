import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import {
  ASSURED_RIDE_DRIVER_DEPOSIT_REF,
  calculateDriverAssuredDeposit,
} from '../assured/assured-deposit.math';
import { AssuredLifecycleService } from '../assured/assured-lifecycle.service';
import {
  AssuredRideLifecycleResponseDto,
  HalfTimeDecisionResponseDto,
} from '../assured/dto/assured-lifecycle-response.dto';
import { Booking } from '../bookings/entities/booking.entity';
import {
  BookingCancellationReason,
  BookingPickupStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import { BookingsService } from '../bookings/bookings.service';
import { SettingsService } from '../settings/settings.service';
import { TrackingService } from '../tracking/tracking.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { VerificationService } from '../verification/verification.service';
import { VerificationType } from '../verification/enums/verification.enums';
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
    private readonly verificationService: VerificationService,
    private readonly walletService: WalletService,
    private readonly settingsService: SettingsService,
    private readonly assuredLifecycleService: AssuredLifecycleService,
    private readonly bookingsService: BookingsService,
    private readonly trackingService: TrackingService,
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
   * Start a Regular ride: PUBLISHED → IN_PROGRESS.
   * Zero confirmed passengers is allowed (same as empty completion historically).
   * Assured rides are not started via this endpoint.
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

      if (ride.rideType !== RideType.REGULAR) {
        throw new BadRequestException(
          'Only Regular rides can be started via this endpoint',
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

      if (ride.status !== RideStatus.PUBLISHED) {
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

  async create(driverId: string, dto: CreateRideDto): Promise<RideResponseDto> {
    await this.assertDriverCanPublish(driverId, dto.vehicleId);

    if (dto.rideType === RideType.ASSURED) {
      return this.createAssuredRide(driverId, dto);
    }

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
    });

    const saved = await this.rideRepository.save(ride);
    return this.toResponse(saved);
  }

  /**
   * Atomic Assured publish: Wallet → Balance → Lots → Ride.
   * Driver deposit hold + ride publication commit together.
   */
  private async createAssuredRide(
    driverId: string,
    dto: CreateRideDto,
  ): Promise<RideResponseDto> {
    const percentage =
      await this.settingsService.getAssuredRideDepositPercentage();
    const pricePerSeat = BigInt(dto.pricePerSeat);
    const depositAmount = calculateDriverAssuredDeposit(
      dto.totalSeats,
      pricePerSeat,
      percentage,
    );
    const rideId = randomUUID();
    const idempotencyKey = `assured-driver-deposit:${rideId}`;

    try {
      return await this.dataSource.transaction(async (manager) => {
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
              idempotencyKey,
            },
          );
          driverDepositHoldId = holdResult.hold!.id;
        }

        const ride = manager.getRepository(Ride).create({
          id: rideId,
          driverId,
          vehicleId: dto.vehicleId,
          rideType: RideType.ASSURED,
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
          assuredDepositPercentage: percentage,
          assuredDepositAmount: depositAmount.toString(),
          driverDepositHoldId,
        });

        const saved = await manager.getRepository(Ride).save(ride);
        return this.toResponse(saved);
      });
    } catch (error) {
      if (
        error instanceof InsufficientWalletBalanceError ||
        error instanceof WalletNotFoundError ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      throw error;
    }
  }

  async findMine(driverId: string): Promise<RideResponseDto[]> {
    const rides = await this.rideRepository.find({
      where: { driverId },
      order: { departureDate: 'ASC', departureTime: 'ASC', createdAt: 'DESC' },
    });
    return rides.map((ride) => this.toResponse(ride));
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
      where: {
        id: rideId,
        status: RideStatus.PUBLISHED,
      },
    });
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    const [item] = await this.toSearchItems([ride]);
    return item;
  }

  async search(dto: SearchRidesDto): Promise<RideSearchPageDto> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;

    const qb = this.rideRepository
      .createQueryBuilder('ride')
      .where('ride.status = :status', { status: RideStatus.PUBLISHED })
      .andWhere('ride.departure_date = :date', { date: dto.date })
      .andWhere('LOWER(ride.source) LIKE LOWER(:source)', {
        source: `%${dto.source.trim()}%`,
      })
      .andWhere('LOWER(ride.destination) LIKE LOWER(:destination)', {
        destination: `%${dto.destination.trim()}%`,
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

  async update(
    driverId: string,
    rideId: string,
    dto: UpdateRideDto,
  ): Promise<RideResponseDto> {
    const ride = await this.requireOwnedRide(driverId, rideId);

    if (
      ride.rideType === RideType.ASSURED &&
      ride.driverDepositHoldId !== null
    ) {
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
    if (dto.totalSeats !== undefined) {
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

    const saved = await this.rideRepository.save(ride);
    return this.toResponse(saved);
  }

  /**
   * Dedicated completion: PUBLISHED → COMPLETED.
   * Assured rides also release ACTIVE driver/rider ASSURED_DEPOSIT holds.
   *
   * Lock order: Ride → (holds sorted by walletId, holdId): Hold → Balance → Lots
   * → Booking updates → Ride COMPLETED.
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

        if (ride.rideType === RideType.REGULAR) {
          if (ride.status !== RideStatus.IN_PROGRESS) {
            throw new ConflictException(
              'Regular rides must be started (IN_PROGRESS) before completion',
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

          ride.status = RideStatus.COMPLETED;
          await manager.getRepository(Ride).save(ride);

          return {
            rideId: ride.id,
            status: RideStatus.COMPLETED,
            rideType: ride.rideType,
            alreadyCompleted: false,
          };
        }

        if (ride.status !== RideStatus.PUBLISHED) {
          throw new ConflictException(
            `Ride cannot be completed from status ${ride.status}`,
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

          // Deterministic order: walletId then holdId
          releasePlan.sort((a, b) => {
            const walletCmp = a.walletId.localeCompare(b.walletId);
            if (walletCmp !== 0) {
              return walletCmp;
            }
            return a.holdId.localeCompare(b.holdId);
          });

          for (const target of releasePlan) {
            const result = await this.walletService.releaseHoldInTransaction(
              manager,
              {
                holdId: target.holdId,
                idempotencyKey: `assured-deposit-release:${target.holdId}`,
              },
            );
            const amount = BigInt(result.hold?.amount ?? target.amount);
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

      if (result.rideType === RideType.REGULAR) {
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

  private async toSearchItems(rides: Ride[]): Promise<RideSearchItemDto[]> {
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

      return {
        id: ride.id,
        rideType: ride.rideType,
        source: ride.source,
        destination: ride.destination,
        departureDate: ride.departureDate,
        departureTime: this.formatTime(ride.departureTime),
        availableSeats: ride.availableSeats,
        totalSeats: ride.totalSeats,
        pricePerSeat: ride.pricePerSeat,
        preferences: {
          maxTwoInBackSeat: ride.maxTwoInBackSeat,
          noSmoking: ride.noSmoking,
          noPets: ride.noPets,
          luggageAllowed: ride.luggageAllowed,
        },
        notes: ride.notes,
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

  private toResponse(ride: Ride): RideResponseDto {
    return {
      id: ride.id,
      driverId: ride.driverId,
      vehicleId: ride.vehicleId,
      rideType: ride.rideType,
      status: ride.status,
      source: ride.source,
      destination: ride.destination,
      departureDate: ride.departureDate,
      departureTime: this.formatTime(ride.departureTime),
      totalSeats: ride.totalSeats,
      availableSeats: ride.availableSeats,
      pricePerSeat: ride.pricePerSeat,
      maxTwoInBackSeat: ride.maxTwoInBackSeat,
      noSmoking: ride.noSmoking,
      noPets: ride.noPets,
      luggageAllowed: ride.luggageAllowed,
      notes: ride.notes,
      assuredDepositPercentage: ride.assuredDepositPercentage,
      assuredDepositAmount: ride.assuredDepositAmount,
      regularSeatsPolicy: ride.regularSeatsPolicy,
      createdAt: ride.createdAt.toISOString(),
      updatedAt: ride.updatedAt.toISOString(),
    };
  }

  private formatTime(value: string): string {
    return value.length >= 8 ? value.slice(0, 8) : value;
  }
}
