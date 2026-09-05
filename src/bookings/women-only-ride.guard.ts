import { RideType } from '../rides/enums/ride.enums';
import { Gender } from '../users/entities/user-profile.entity';
import { WomenOnlyRideError } from '../users/errors/gender.errors';

/**
 * Backend-authoritative Women Only eligibility.
 * Uses persisted UserProfile.gender only — never client-supplied gender.
 */
export function assertWomenOnlyBookingAllowed(params: {
  rideType: RideType;
  womenOnly: boolean;
  passengerGender: Gender | null | undefined;
}): void {
  if (!params.womenOnly) {
    return;
  }

  // Women Only applies to REGULAR and ASSURED only (not COMMUTE).
  if (
    params.rideType !== RideType.REGULAR &&
    params.rideType !== RideType.ASSURED
  ) {
    return;
  }

  if (params.passengerGender !== Gender.FEMALE) {
    throw new WomenOnlyRideError();
  }
}
