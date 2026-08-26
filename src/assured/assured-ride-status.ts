import { RideStatus, RideType } from '../rides/enums/ride.enums';

/** Regular rides remain bookable/searchable when PUBLISHED. */
export function isRegularPublishedStatus(status: RideStatus): boolean {
  return status === RideStatus.PUBLISHED;
}

/** Assured rides visible in passenger search (must also have seats). */
export function isAssuredSearchVisibleStatus(status: RideStatus): boolean {
  return status === RideStatus.ASSURANCE_ACTIVE;
}

/** Assured offer is search-visible only when ACTIVE and bookable seats remain. */
export function isAssuredSearchVisibleOffer(
  status: RideStatus,
  availableSeats: number,
): boolean {
  return isAssuredSearchVisibleStatus(status) && availableSeats > 0;
}

/** Assured rides that accept new bookings. */
export function isAssuredBookableStatus(status: RideStatus): boolean {
  return status === RideStatus.ASSURANCE_ACTIVE;
}

/** Assured pre-trip offer states (queue membership, before IN_PROGRESS). */
export function isAssuredPreTripOfferStatus(status: RideStatus): boolean {
  return (
    status === RideStatus.ASSURANCE_ACTIVE ||
    status === RideStatus.ASSURANCE_PENDING
  );
}

export function isAssuredStartableStatus(status: RideStatus): boolean {
  return status === RideStatus.ASSURANCE_ACTIVE;
}

export function assertRideStartableForType(
  rideType: RideType,
  status: RideStatus,
): boolean {
  if (rideType === RideType.ASSURED) {
    return isAssuredStartableStatus(status);
  }
  return isRegularPublishedStatus(status);
}
