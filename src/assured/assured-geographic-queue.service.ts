import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Ride } from '../rides/entities/ride.entity';
import { SettingsService } from '../settings/settings.service';
import { calculateAssuranceWindow } from './assured-window.math';
import {
  buildAssuredQueueCoarseLockKeys,
  formatGeographicQueueAuditKey,
  isRideCompatibleWithGeographicQueue,
} from './assured-route-compatibility';
import { AssuredGeographicQueue } from './entities/assured-geographic-queue.entity';

@Injectable()
export class AssuredGeographicQueueService {
  constructor(private readonly settingsService: SettingsService) {}

  /**
   * Resolve assurance window, find-or-create a compatible geographic queue,
   * and assign {@link Ride.assuredQueueId}.
   */
  async assignGeographicQueueInTransaction(
    manager: EntityManager,
    ride: Ride,
  ): Promise<void> {
    this.assertRideHasQueueGeometry(ride);

    const window = calculateAssuranceWindow(
      ride.departureDate,
      ride.departureTime,
    );
    ride.assuranceWindowStart = window.windowStartTime;
    ride.assuranceWindowEnd = window.windowEndTime;

    const corridorRadiusMeters =
      await this.settingsService.getAssuredQueueCorridorRadiusMeters();

    const lockKeys = buildAssuredQueueCoarseLockKeys({
      departureDate: ride.departureDate,
      windowId: window.windowId,
      destinationLatitude: ride.destinationLatitude!,
      destinationLongitude: ride.destinationLongitude!,
    });
    for (const lockKey of lockKeys) {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        lockKey,
      ]);
    }

    const candidates = await this.findCandidateQueues(manager, {
      departureDate: ride.departureDate,
      assuranceWindowStart: window.windowStartTime,
      assuranceWindowEnd: window.windowEndTime,
      destinationLatitude: ride.destinationLatitude!,
      destinationLongitude: ride.destinationLongitude!,
    });

    for (const queue of candidates) {
      if (
        isRideCompatibleWithGeographicQueue(
          {
            sourceLatitude: ride.sourceLatitude!,
            sourceLongitude: ride.sourceLongitude!,
            destinationLatitude: ride.destinationLatitude!,
            destinationLongitude: ride.destinationLongitude!,
            routePolyline: ride.routePolyline!,
          },
          queue,
        )
      ) {
        ride.assuredQueueId = queue.id;
        ride.assuredQueueKey = formatGeographicQueueAuditKey(queue.id);
        return;
      }
    }

    const created = await this.createQueueFromRide(
      manager,
      ride,
      window.windowStartTime,
      window.windowEndTime,
      corridorRadiusMeters,
    );
    ride.assuredQueueId = created.id;
    ride.assuredQueueKey = formatGeographicQueueAuditKey(created.id);
  }

  private assertRideHasQueueGeometry(ride: Ride): void {
    const missing: string[] = [];
    if (ride.sourceLatitude == null || ride.sourceLongitude == null) {
      missing.push('source coordinates');
    }
    if (ride.destinationLatitude == null || ride.destinationLongitude == null) {
      missing.push('destination coordinates');
    }
    if (!ride.routePolyline?.trim()) {
      missing.push('route geometry');
    }
    if (missing.length > 0) {
      throw new BadRequestException(
        `Assured ride publishing requires ${missing.join(', ')} for geographic queue assignment`,
      );
    }
  }

  /**
   * Prefilter using each queue's snapshotted corridor radius so admin radius
   * shrinks cannot exclude still-compatible queues before exact matching.
   */
  private async findCandidateQueues(
    manager: EntityManager,
    params: {
      departureDate: string;
      assuranceWindowStart: string;
      assuranceWindowEnd: string;
      destinationLatitude: number;
      destinationLongitude: number;
    },
  ): Promise<AssuredGeographicQueue[]> {
    return manager
      .getRepository(AssuredGeographicQueue)
      .createQueryBuilder('queue')
      .where('queue.departure_date = :departureDate', {
        departureDate: params.departureDate,
      })
      .andWhere('queue.assurance_window_start = :windowStart', {
        windowStart: params.assuranceWindowStart,
      })
      .andWhere('queue.assurance_window_end = :windowEnd', {
        windowEnd: params.assuranceWindowEnd,
      })
      .andWhere(
        `ABS(queue.anchor_destination_latitude - :destLat)
          <= (queue.corridor_radius_meters::float / 111320.0)`,
        { destLat: params.destinationLatitude },
      )
      .andWhere(
        `ABS(queue.anchor_destination_longitude - :destLng)
          <= CASE
            WHEN COS(RADIANS(:destLatLng)) > 0.01
            THEN queue.corridor_radius_meters::float
              / (111320.0 * COS(RADIANS(:destLatLng)))
            ELSE queue.corridor_radius_meters::float / 111320.0
          END`,
        {
          destLng: params.destinationLongitude,
          destLatLng: params.destinationLatitude,
        },
      )
      .orderBy('queue.created_at', 'ASC')
      .addOrderBy('queue.id', 'ASC')
      .getMany();
  }

  private async createQueueFromRide(
    manager: EntityManager,
    ride: Ride,
    assuranceWindowStart: string,
    assuranceWindowEnd: string,
    corridorRadiusMeters: number,
  ): Promise<AssuredGeographicQueue> {
    const queue = manager.getRepository(AssuredGeographicQueue).create({
      departureDate: ride.departureDate,
      assuranceWindowStart,
      assuranceWindowEnd,
      canonicalPolyline: ride.routePolyline!,
      anchorSourceLatitude: ride.sourceLatitude!,
      anchorSourceLongitude: ride.sourceLongitude!,
      anchorDestinationLatitude: ride.destinationLatitude!,
      anchorDestinationLongitude: ride.destinationLongitude!,
      corridorRadiusMeters,
    });
    return manager.getRepository(AssuredGeographicQueue).save(queue);
  }
}
