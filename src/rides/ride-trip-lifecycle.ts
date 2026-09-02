import { RideType } from './enums/ride.enums';

/**
 * Ride types that share the core trip lifecycle:
 * start → IN_PROGRESS → pickup OTP → live tracking → complete.
 *
 * COMMUTE uses the same execution lifecycle; booking/payment differs (upfront pay,
 * driver accept/reject, pending requests do not hold seats).
 */
export function supportsTripLifecycle(rideType: RideType): boolean {
  return (
    rideType === RideType.REGULAR ||
    rideType === RideType.ASSURED ||
    rideType === RideType.COMMUTE
  );
}
