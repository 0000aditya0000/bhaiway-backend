import { RideType } from './enums/ride.enums';

/**
 * Ride types that share the core trip lifecycle:
 * start → IN_PROGRESS → pickup OTP → live tracking → complete.
 */
export function supportsTripLifecycle(rideType: RideType): boolean {
  return rideType === RideType.REGULAR || rideType === RideType.ASSURED;
}
