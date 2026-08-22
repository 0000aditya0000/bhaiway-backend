export const REDIS_CLIENT = 'REDIS_CLIENT';

/** Redis key for the latest driver location of an active ride. */
export function rideTrackingKey(rideId: string): string {
  return `ride:tracking:${rideId}`;
}

/** TTL for current location (seconds). Stops serving forever-stale GPS. */
export const RIDE_TRACKING_TTL_SECONDS = 120;

/**
 * Age after which GET marks the location as stale while still returning
 * last-known coordinates (milliseconds).
 */
export const RIDE_TRACKING_STALE_AFTER_MS = 45_000;
