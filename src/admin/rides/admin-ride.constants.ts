export const ADMIN_RIDE_LIST_MAX = 100;

export function adminRideCancelIdempotencyKey(rideId: string): string {
  return `admin-cancel:ride:${rideId}`;
}

export function adminRideRefundKey(rideId: string, bookingId: string): string {
  return `admin-cancel:refund:${rideId}:${bookingId}`;
}

export function adminRideHoldReleaseKey(holdId: string): string {
  return `admin-cancel:hold-release:${holdId}`;
}

export function adminRideNotifyKey(
  rideId: string,
  recipientUserId: string,
): string {
  return `admin-ops-cancel:${rideId}:${recipientUserId}`;
}

export const ADMIN_OPS_PASSENGER_CANCEL_BODY =
  'Your ride has been cancelled by BhaiWay Operations. If you have any questions regarding a refund or compensation, please contact BhaiWay Support for assistance.';

export const ADMIN_OPS_DRIVER_CANCEL_BODY =
  'Your ride has been cancelled by BhaiWay Operations. If you have any questions regarding payment or compensation, please contact BhaiWay Support for assistance.';

export const ADMIN_PRETRIP_PASSENGER_CANCEL_BODY =
  'Your ride has been cancelled by BhaiWay Operations. Any collected wallet payment for this booking has been refunded where applicable.';

export const ADMIN_PRETRIP_DRIVER_CANCEL_BODY =
  'Your ride has been cancelled by BhaiWay Operations.';
