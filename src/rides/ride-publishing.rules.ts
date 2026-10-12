import { isAtOrAfterDeparture } from '../assured/assured-timing';
import { RideStatus } from './enums/ride.enums';
import { RideDepartureInPastError } from './errors/ride-publishing.errors';

/**
 * Assured rides that still block publishing another Assured ride for the same driver.
 * Terminal (do not block): COMPLETED, CANCELLED.
 * Unused for Assured publish lifecycle: DRAFT, PUBLISHED.
 */
export const ACTIVE_ASSURED_RIDE_STATUSES: readonly RideStatus[] = [
  RideStatus.ASSURANCE_PENDING,
  RideStatus.ASSURANCE_ACTIVE,
  RideStatus.IN_PROGRESS,
] as const;

export function assertDepartureIsInFuture(
  departureDate: string,
  departureTime: string,
  now: Date = new Date(),
): void {
  if (isAtOrAfterDeparture(now, departureDate, departureTime)) {
    throw new RideDepartureInPastError();
  }
}
