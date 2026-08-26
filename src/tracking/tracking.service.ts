import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { In, Repository } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { BookingStatus } from '../bookings/enums/booking.enums';
import { Ride } from '../rides/entities/ride.entity';
import { RideStatus } from '../rides/enums/ride.enums';
import { supportsTripLifecycle } from '../rides/ride-trip-lifecycle';
import { UpdateDriverLocationDto } from './dto/update-driver-location.dto';
import {
  RideLocationUpdatedEventDto,
  RideTrackingResponseDto,
} from './dto/ride-tracking-response.dto';
import { safeRedisErrorMessage } from './redis/redis-config';
import {
  REDIS_CLIENT,
  RIDE_TRACKING_ABSOLUTE_MIN_INTERVAL_MS,
  RIDE_TRACKING_MAX_FUTURE_MS,
  RIDE_TRACKING_MIN_MOVE_METERS,
  RIDE_TRACKING_MIN_UPDATE_INTERVAL_MS,
  RIDE_TRACKING_OUT_OF_ORDER_GRACE_MS,
  RIDE_TRACKING_STALE_AFTER_MS,
  RIDE_TRACKING_TTL_SECONDS,
  rideTrackingKey,
} from './tracking.constants';
import { TrackingGateway } from './tracking.gateway';

interface StoredRideLocation {
  rideId: string;
  driverId: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  updatedAt: string;
  heading?: number;
  speed?: number;
}

export type RideTrackingResponseWithMeta = RideTrackingResponseDto & {
  throttled?: boolean;
};

@Injectable()
export class TrackingService implements OnModuleDestroy {
  private readonly logger = new Logger('Tracking');

  /** Per-ride last accepted write time (process-local soft rate limit). */
  private readonly lastAcceptMsByRide = new Map<string, number>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @Optional()
    @Inject(forwardRef(() => TrackingGateway))
    private readonly trackingGateway?: TrackingGateway,
  ) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  /**
   * Authorize Socket.IO room join. Drivers must own an IN_PROGRESS trip-lifecycle ride;
   * passengers need an eligible booking on that active ride.
   */
  async assertCanJoinTrackingRoom(
    userId: string,
    rideId: string,
  ): Promise<{ role: 'driver' | 'passenger' }> {
    const ride = await this.rideRepository.findOne({ where: { id: rideId } });
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    if (!supportsTripLifecycle(ride.rideType)) {
      throw new BadRequestException(
        'Live tracking applies only to trip-lifecycle rides',
      );
    }

    if (ride.status !== RideStatus.IN_PROGRESS) {
      throw new ConflictException(
        'Tracking rooms are only available while the ride is IN_PROGRESS',
      );
    }

    if (ride.driverId === userId) {
      return { role: 'driver' };
    }

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
      throw new ForbiddenException('Not authorized to track this ride');
    }

    return { role: 'passenger' };
  }

  async updateDriverLocation(
    driverId: string,
    rideId: string,
    dto: UpdateDriverLocationDto,
  ): Promise<RideTrackingResponseWithMeta> {
    this.logger.log(
      `[Tracking][driver] location received ride=${rideId} redisStatus=${this.redis.status}`,
    );

    const ride = await this.rideRepository.findOne({ where: { id: rideId } });
    if (!ride || ride.driverId !== driverId) {
      throw new NotFoundException('Ride not found');
    }

    if (!supportsTripLifecycle(ride.rideType)) {
      throw new BadRequestException(
        'Live tracking applies only to trip-lifecycle rides',
      );
    }

    if (ride.status === RideStatus.CANCELLED) {
      throw new ConflictException(
        'Cancelled rides cannot accept location updates',
      );
    }

    if (ride.status === RideStatus.COMPLETED) {
      throw new ConflictException(
        'Completed rides cannot accept location updates',
      );
    }

    if (ride.status !== RideStatus.IN_PROGRESS) {
      throw new ConflictException(
        'Location updates are only accepted while the ride is IN_PROGRESS',
      );
    }

    this.assertValidCoordinates(dto.latitude, dto.longitude);
    this.assertOptionalMotionFields(dto.heading, dto.speed);

    const now = new Date();
    const clientTs = dto.timestamp ? new Date(dto.timestamp) : now;
    if (Number.isNaN(clientTs.getTime())) {
      throw new BadRequestException('Invalid timestamp');
    }
    if (clientTs.getTime() - now.getTime() > RIDE_TRACKING_MAX_FUTURE_MS) {
      throw new BadRequestException('timestamp is too far in the future');
    }

    const existing = await this.readStoredLocation(ride.id);

    if (existing) {
      const lastTs = Date.parse(existing.timestamp);
      if (
        Number.isFinite(lastTs) &&
        clientTs.getTime() < lastTs - RIDE_TRACKING_OUT_OF_ORDER_GRACE_MS
      ) {
        throw new BadRequestException(
          'timestamp is older than the last accepted location',
        );
      }

      if (
        existing.timestamp === clientTs.toISOString() &&
        existing.latitude === dto.latitude &&
        existing.longitude === dto.longitude
      ) {
        return { ...this.toResponse(ride, existing), throttled: true };
      }
    }

    const lastAcceptMs = this.lastAcceptMsByRide.get(ride.id);
    if (lastAcceptMs !== undefined) {
      const elapsed = now.getTime() - lastAcceptMs;
      const movedMeters =
        existing == null
          ? Number.POSITIVE_INFINITY
          : haversineMeters(
              existing.latitude,
              existing.longitude,
              dto.latitude,
              dto.longitude,
            );

      if (movedMeters < RIDE_TRACKING_MIN_MOVE_METERS) {
        if (elapsed < RIDE_TRACKING_MIN_UPDATE_INTERVAL_MS) {
          this.logger.log(
            `[Tracking][driver] location throttled ride=${ride.id} reason=soft_interval`,
          );
          return { ...this.toResponse(ride, existing), throttled: true };
        }
      } else if (elapsed < RIDE_TRACKING_ABSOLUTE_MIN_INTERVAL_MS) {
        this.logger.log(
          `[Tracking][driver] location throttled ride=${ride.id} reason=absolute_min`,
        );
        return { ...this.toResponse(ride, existing), throttled: true };
      }
    }

    const payload: StoredRideLocation = {
      rideId: ride.id,
      driverId,
      latitude: dto.latitude,
      longitude: dto.longitude,
      timestamp: clientTs.toISOString(),
      updatedAt: now.toISOString(),
    };

    if (dto.heading !== undefined) {
      payload.heading = dto.heading;
    }
    if (dto.speed !== undefined) {
      payload.speed = dto.speed;
    }

    const key = rideTrackingKey(ride.id);
    await this.setLocationAtomic(key, payload);
    this.lastAcceptMsByRide.set(ride.id, now.getTime());

    this.logger.log(
      `[Tracking][driver] location stored ride=${ride.id} ttl=${RIDE_TRACKING_TTL_SECONDS}s`,
    );

    const response = this.toResponse(ride, payload);
    this.emitLocationBroadcast(response);
    return response;
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

    if (!supportsTripLifecycle(ride.rideType)) {
      throw new BadRequestException(
        'Live tracking applies only to trip-lifecycle rides',
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
  async clearRideTracking(
    rideId: string,
    reason: 'complete' | 'cancel' | 'ended' = 'ended',
  ): Promise<void> {
    const key = rideTrackingKey(rideId);
    this.lastAcceptMsByRide.delete(rideId);
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

    try {
      await this.trackingGateway?.broadcastTrackingEnded(rideId, reason);
    } catch (error) {
      this.logger.warn(
        `[Tracking] ended broadcast failed ride=${rideId} err=${safeRedisErrorMessage(error)}`,
      );
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

  private emitLocationBroadcast(response: RideTrackingResponseDto): void {
    if (!response.driverCoordinate || !response.updatedAt) {
      return;
    }
    const event: RideLocationUpdatedEventDto = {
      rideId: response.rideId,
      driverCoordinate: response.driverCoordinate,
      updatedAt: response.updatedAt,
    };
    try {
      this.trackingGateway?.broadcastLocationUpdated(response.rideId, event);
    } catch (error) {
      this.logger.warn(
        `[Tracking] broadcast failed ride=${response.rideId} err=${safeRedisErrorMessage(error)}`,
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

    const driverCoordinate: RideTrackingResponseDto['driverCoordinate'] = {
      latitude: stored.latitude,
      longitude: stored.longitude,
      timestamp: stored.timestamp,
    };
    if (stored.heading !== undefined) {
      driverCoordinate.heading = stored.heading;
    }
    if (stored.speed !== undefined) {
      driverCoordinate.speed = stored.speed;
    }

    return {
      rideId: ride.id,
      rideStatus: ride.status,
      driverCoordinate,
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
    if (latitude === 0 && longitude === 0) {
      throw new BadRequestException('Invalid coordinates');
    }
  }

  private assertOptionalMotionFields(
    heading?: number,
    speed?: number,
  ): void {
    if (heading !== undefined) {
      if (!Number.isFinite(heading) || heading < 0 || heading > 360) {
        throw new BadRequestException('Invalid heading');
      }
    }
    if (speed !== undefined) {
      if (!Number.isFinite(speed) || speed < 0) {
        throw new BadRequestException('Invalid speed');
      }
    }
  }
}

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const earthRadiusM = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(a));
}
