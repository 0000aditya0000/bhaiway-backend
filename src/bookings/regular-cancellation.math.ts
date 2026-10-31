export function regularRiderCancelRefundKey(bookingId: string): string {
  return `regular:rider-cancel:${bookingId}`;
}
