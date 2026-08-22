import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { In, Repository } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { BookingStatus } from '../bookings/enums/booking.enums';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus, RideType } from '../rides/enums/ride.enums';
import { UpdateDriverLocationDto } from './dto/update-driver-location.dto';
import { RideTrackingResponseDto } from './dto/ride-tracking-response.dto';
import { safeRedisErrorMessage } from './redis/redis-config';
import {
  REDIS_CLIENT,
  RIDE_TRACKING_STALE_AFTER_MS,
  RIDE_TRACKING_TTL_SECONDS,
  rideTrackingKey,
} from './tracking.constants';

interface StoredRideLocation {
  rideId: string;
  driverId: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  updatedAt: string;
}

@Injectable()
export class TrackingService implements OnModuleDestroy {
  private readonly logger = new Logger('Tracking');

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
  ) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  async updateDriverLocation(
    driverId: string,
    rideId: string,
    dto: UpdateDriverLocationDto,
  ): Promise<RideTrackingResponseDto> {
    this.logger.log(
      `[Tracking][driver] location received ride=${rideId} redisStatus=${this.redis.status}`,
    );

    const ride = await this.rideRepository.findOne({ where: { id: rideId } });
    if (!ride || ride.driverId !== driverId) {
      throw new NotFoundException('Ride not found');
    }

    if (ride.rideType !== RideType.REGULAR) {
      throw new BadRequestException(
        'Live tracking applies only to Regular rides',
      );
    }

    if (ride.status === RideStatus.CANCELLED) {
      throw new ConflictException('Cancelled rides cannot accept location updates');
    }

    if (ride.status === RideStatus.COMPLETED) {
      throw new ConflictException('Completed rides cannot accept location updates');
    }

    if (ride.status !== RideStatus.IN_PROGRESS) {
      throw new ConflictException(
        'Location updates are only accepted while the ride is IN_PROGRESS',
      );
    }

    this.assertValidCoordinates(dto.latitude, dto.longitude);

    const now = new Date();
    const clientTs = dto.timestamp ? new Date(dto.timestamp) : now;
    if (Number.isNaN(clientTs.getTime())) {
      throw new BadRequestException('Invalid timestamp');
    }
    // Reject absurd future clocks (> 2 minutes ahead).
    if (clientTs.getTime() - now.getTime() > 120_000) {
      throw new BadRequestException('timestamp is too far in the future');
    }

    const payload: StoredRideLocation = {
      rideId: ride.id,
      driverId,
      latitude: dto.latitude,
      longitude: dto.longitude,
      timestamp: clientTs.toISOString(),
      updatedAt: now.toISOString(),
    };

    const key = rideTrackingKey(ride.id);
    await this.setLocationAtomic(key, payload);

    this.logger.log(
      `[Tracking][driver] location stored ride=${ride.id} ttl=${RIDE_TRACKING_TTL_SECONDS}s`,
    );

    return this.toResponse(ride, payload);
  }

  async getRideTracking(
    userId: string,
    rideId: string,
  ): Promise<RideTrackingResponseDto> {
    const started = Date.now();
    this.logger.log(
      `[Tracking][passenger] location requested ride=${rideId} redisStatus=${this.redis.status}`,
    );

    const ride = await this.rideRepository.findOne({ where: { id: rideId } });
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    if (ride.rideType !== RideType.REGULAR) {
      throw new BadRequestException(
        'Live tracking applies only to Regular rides',
      );
    }

    const isDriver = ride.driverId === userId;
    if (!isDriver) {
      const booking = await this.bookingRepository.findOne({
        where: {
          rideId: ride.id,
          passengerId: userId,
          status: In([
            BookingStatus.PENDING,
            BookingStatus.CONFIRMED,
            BookingStatus.COMPLETED,
          ]),
        },
      });
      if (!booking) {
        throw new NotFoundException('Ride not found');
      }
    }

    const stored = await this.readStoredLocation(ride.id);
    const response = this.toResponse(ride, stored);
    const elapsedMs = Date.now() - started;

    this.logger.log(
      `[Tracking][passenger] location returned ride=${ride.id} hasCoordinate=${Boolean(
        response.driverCoordinate,
      )} isStale=${response.isStale} elapsedMs=${elapsedMs}`,
    );

    return response;
  }

  /** Clears Redis tracking state when a ride ends (complete/cancel). */
  async clearRideTracking(rideId: string): Promise<void> {
    const key = rideTrackingKey(rideId);
    try {
      this.logger.log(
        `[Tracking] clear started ride=${rideId} redisStatus=${this.redis.status}`,
      );
      await this.redis.del(key);
      this.logger.log(`[Tracking] cleared ride=${rideId}`);
    } catch (error) {
      this.logger.error(
        `[Tracking] clear failed ride=${rideId} err=${safeRedisErrorMessage(error)}`,
      );
      // Do not block ride complete/cancel on Redis; TTL will expire the key.
    }
  }

  /**
   * Single atomic SET with EX TTL (one round-trip). Avoids separate EXPIRE.
   */
  private async setLocationAtomic(
    key: string,
    payload: StoredRideLocation,
  ): Promise<void> {
    const started = Date.now();
    await this.ensureRedisReady('driver', 'SET');

    this.logger.log(
      `[Tracking][driver] SET started redisStatus=${this.redis.status}`,
    );

    try {
      await this.redis.set(
        key,
        JSON.stringify(payload),
        'EX',
        RIDE_TRACKING_TTL_SECONDS,
      );
      this.logger.log(
        `[Tracking][driver] SET+TTL succeeded elapsedMs=${Date.now() - started}`,
      );
    } catch (error) {
      this.logger.error(
        `[Tracking][driver] SET+TTL failed elapsedMs=${Date.now() - started} err=${safeRedisErrorMessage(error)}`,
      );
      throw new ServiceUnavailableException(
        'Live tracking temporarily unavailable',
      );
    }
  }

  private async readStoredLocation(
    rideId: string,
  ): Promise<StoredRideLocation | null> {
    const started = Date.now();
    await this.ensureRedisReady('passenger', 'GET');

    this.logger.log(
      `[Tracking][passenger] GET started redisStatus=${this.redis.status}`,
    );

    try {
      const raw = await this.redis.get(rideTrackingKey(rideId));
      this.logger.log(
        `[Tracking][passenger] GET succeeded hit=${Boolean(raw)} elapsedMs=${Date.now() - started}`,
      );
      if (!raw) {
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as StoredRideLocation;
        if (
          typeof parsed.latitude !== 'number' ||
          typeof parsed.longitude !== 'number'
        ) {
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      this.logger.error(
        `[Tracking][passenger] GET failed elapsedMs=${Date.now() - started} err=${safeRedisErrorMessage(error)}`,
      );
      throw new ServiceUnavailableException(
        'Live tracking temporarily unavailable',
      );
    }
  }

  /**
   * If the client gave up (status=end) or is mid-reconnect, try to bring it back
   * briefly before failing the HTTP request.
   */
  private async ensureRedisReady(
    actor: 'driver' | 'passenger',
    op: 'SET' | 'GET',
  ): Promise<void> {
    const currentStatus = (): string => String(this.redis.status);

    if (currentStatus() === 'ready') {
      return;
    }

    this.logger.warn(
      `[Tracking][${actor}] ${op} redis not ready (status=${currentStatus()}) — attempting reconnect`,
    );

    try {
      const statusBefore = currentStatus();
      if (statusBefore === 'wait' || statusBefore === 'end') {
        await this.redis.connect();
      }
      // Brief wait for ready after connect/reconnect kickoff.
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if (currentStatus() === 'ready') {
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    } catch (error) {
      this.logger.error(
        `[Tracking][${actor}] ${op} reconnect failed err=${safeRedisErrorMessage(error)}`,
      );
    }

    if (currentStatus() !== 'ready') {
      this.logger.error(
        `[Tracking][${actor}] ${op} aborted: redis not ready (status=${currentStatus()})`,
      );
      throw new ServiceUnavailableException(
        'Live tracking temporarily unavailable',
      );
    }
  }

  private toResponse(
    ride: Ride,
    stored: StoredRideLocation | null,
  ): RideTrackingResponseDto {
    if (!stored) {
      return {
        rideId: ride.id,
        rideStatus: ride.status,
        driverCoordinate: null,
        updatedAt: null,
        isStale: true,
      };
    }

    const updatedAtMs = Date.parse(stored.updatedAt);
    const ageMs = Number.isFinite(updatedAtMs)
      ? Date.now() - updatedAtMs
      : Number.POSITIVE_INFINITY;
    const isStale = ageMs > RIDE_TRACKING_STALE_AFTER_MS;

    return {
      rideId: ride.id,
      rideStatus: ride.status,
      driverCoordinate: {
        latitude: stored.latitude,
        longitude: stored.longitude,
        timestamp: stored.timestamp,
      },
      updatedAt: stored.updatedAt,
      isStale,
    };
  }

  private assertValidCoordinates(latitude: number, longitude: number): void {
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new BadRequestException('Invalid coordinates');
    }
    // Reject the Null Island placeholder often used by demos.
    if (latitude === 0 && longitude === 0) {
      throw new BadRequestException('Invalid coordinates');
    }
  }
}
