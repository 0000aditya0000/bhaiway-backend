export function commuteRiderCancelRefundKey(bookingId: string): string {
  return `commute:rider-cancel:${bookingId}`;
}

export function commuteRideFullRefundKey(bookingId: string): string {
  return `commute:ride-full:${bookingId}`;
}

export function commuteRideCancelRefundKey(bookingId: string): string {
  return `commute:ride-cancel:${bookingId}`;
}

export function commuteRejectRefundKey(bookingId: string): string {
  return `commute:reject:${bookingId}`;
}

export function commuteDriverNoShowRefundKey(bookingId: string): string {
  return `commute:driver-no-show:${bookingId}`;
}

export function commutePassengerNoShowRefundKey(bookingId: string): string {
  return `commute:passenger-no-show:${bookingId}`;
}
