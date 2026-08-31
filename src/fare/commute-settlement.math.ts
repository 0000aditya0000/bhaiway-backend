/** Idempotency keys for Commute completion settlement ledger operations. */
export function commuteSettlementDriverCreditKey(bookingId: string): string {
  return `commute:settlement:driver:${bookingId}`;
}

export function commuteSettlementPlatformMarginKey(bookingId: string): string {
  return `commute:settlement:platform:${bookingId}`;
}
