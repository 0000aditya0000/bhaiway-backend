import {
  decodePolyline,
  haversineMeters,
  isValidLatLng,
  matchesRouteCorridor,
} from '../rides/route/route-geometry';

export interface RideRouteCandidate {
  sourceLatitude: number;
  sourceLongitude: number;
  destinationLatitude: number;
  destinationLongitude: number;
  routePolyline: string;
}

export interface GeographicQueueCandidate {
  canonicalPolyline: string;
  anchorDestinationLatitude: number;
  anchorDestinationLongitude: number;
  corridorRadiusMeters: number;
}

/** Matches SettingsService max corridor (200 km). Used for phase-1 lock envelope. */
export const ASSURED_QUEUE_LOCK_RADIUS_METERS = 200_000;

export function formatGeographicQueueAuditKey(queueId: string): string {
  return `geoqueue:${queueId}`;
}

/**
 * Exact geographic compatibility against a queue's canonical corridor.
 * Date/window matching must be enforced by the caller.
 */
export function isRideCompatibleWithGeographicQueue(
  ride: RideRouteCandidate,
  queue: GeographicQueueCandidate,
): boolean {
  const pickup = {
    latitude: ride.sourceLatitude,
    longitude: ride.sourceLongitude,
  };
  const dropoff = {
    latitude: ride.destinationLatitude,
    longitude: ride.destinationLongitude,
  };

  if (!isValidLatLng(pickup) || !isValidLatLng(dropoff)) {
    return false;
  }
  if (!ride.routePolyline?.trim()) {
    return false;
  }

  const routePoints = decodePolyline(queue.canonicalPolyline);
  if (
    !matchesRouteCorridor({
      routePoints,
      pickup,
      dropoff,
      corridorMaxMeters: queue.corridorRadiusMeters,
    })
  ) {
    return false;
  }

  const anchorDestination = {
    latitude: queue.anchorDestinationLatitude,
    longitude: queue.anchorDestinationLongitude,
  };
  if (
    haversineMeters(dropoff, anchorDestination) > queue.corridorRadiusMeters
  ) {
    return false;
  }

  return true;
}

export function buildAssuredQueueDestinationBucket(
  destinationLatitude: number,
  destinationLongitude: number,
): string {
  const latBucket = Math.round(destinationLatitude * 100) / 100;
  const lngBucket = Math.round(destinationLongitude * 100) / 100;
  return `${latBucket}:${lngBucket}`;
}

export function buildAssuredQueueBucketLockKey(params: {
  departureDate: string;
  windowId: string;
  destinationBucket: string;
}): string {
  return `assured-queue:${params.departureDate}:${params.windowId}:${params.destinationBucket}`;
}

export function destinationPrefilterPadsMeters(
  corridorRadiusMeters: number,
  destinationLatitude: number,
): { latPad: number; lngPad: number } {
  const latPad = corridorRadiusMeters / 111_320;
  const cosLat = Math.cos((destinationLatitude * Math.PI) / 180);
  const lngPad =
    cosLat > 0.01 ? corridorRadiusMeters / (111_320 * cosLat) : latPad;
  return { latPad, lngPad };
}

/**
 * Deterministic coarse lock keys covering the destination and its 8 neighbors.
 * Cell size is derived from the max allowed corridor so adjacent destinations
 * that could share a geographic queue cannot create duplicate queues concurrently.
 */
export function buildAssuredQueueCoarseLockKeys(params: {
  departureDate: string;
  windowId: string;
  destinationLatitude: number;
  destinationLongitude: number;
  lockRadiusMeters?: number;
}): string[] {
  const lockRadius =
    params.lockRadiusMeters ?? ASSURED_QUEUE_LOCK_RADIUS_METERS;
  const { latPad, lngPad } = destinationPrefilterPadsMeters(
    lockRadius,
    params.destinationLatitude,
  );
  const cellLat = Math.max(latPad, 0.01);
  const cellLng = Math.max(lngPad, 0.01);

  const i = Math.floor(params.destinationLatitude / cellLat);
  const j = Math.floor(params.destinationLongitude / cellLng);

  const keys: string[] = [];
  for (let di = -1; di <= 1; di += 1) {
    for (let dj = -1; dj <= 1; dj += 1) {
      keys.push(
        `assured-queue-coarse:${params.departureDate}:${params.windowId}:${i + di}:${j + dj}`,
      );
    }
  }
  return [...new Set(keys)].sort();
}

/** Lexicographic UUID order for multi-queue lock acquisition. */
export function sortQueueIdsForLocking(queueIds: string[]): string[] {
  return [...new Set(queueIds.filter(Boolean))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}
