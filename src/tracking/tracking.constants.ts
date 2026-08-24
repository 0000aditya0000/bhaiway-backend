export const REDIS_CLIENT = 'REDIS_CLIENT';

/** Redis key for the latest driver location of an active ride. */
export function rideTrackingKey(rideId: string): string {
  return `ride:tracking:${rideId}`;
}

/** Socket.IO room for a Regular ride's live tracking subscribers. */
export function rideTrackingRoom(rideId: string): string {
  return `ride:${rideId}`;
}

/** TTL for current location (seconds). Stops serving forever-stale GPS. */
export const RIDE_TRACKING_TTL_SECONDS = 120;

/**
 * Age after which GET marks the location as stale while still returning
 * last-known coordinates (milliseconds).
 */
export const RIDE_TRACKING_STALE_AFTER_MS = 45_000;

/**
 * Soft minimum interval between accepted driver location writes when the
 * vehicle has not moved meaningfully. Soft-throttle returns last known
 * without rewriting Redis / rebroadcasting.
 */
export const RIDE_TRACKING_MIN_UPDATE_INTERVAL_MS = 2_000;

/**
 * Hard floor against GPS floods when the vehicle has moved meaningfully.
 * Aligns with ~1 Hz max; mobile targets 2–4s while moving.
 */
export const RIDE_TRACKING_ABSOLUTE_MIN_INTERVAL_MS = 1_000;

/**
 * Movement (meters) that may bypass the soft 2s interval (still subject to
 * the absolute min interval).
 */
export const RIDE_TRACKING_MIN_MOVE_METERS = 15;

/** Allow slightly late GPS clocks before treating as out-of-order. */
export const RIDE_TRACKING_OUT_OF_ORDER_GRACE_MS = 1_000;

/** Reject client clocks more than this far ahead of the server. */
export const RIDE_TRACKING_MAX_FUTURE_MS = 120_000;
