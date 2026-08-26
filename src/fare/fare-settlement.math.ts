/** Idempotency keys for fare settlement ledger operations. */
export function fareSettlementPassengerDebitKey(bookingId: string): string {
  return `fare-settle:passenger-debit:${bookingId}`;
}

export function fareSettlementDriverCreditKey(bookingId: string): string {
  return `fare-settle:driver-credit:${bookingId}`;
}

export function parseFareAmount(totalAmount: string): bigint {
  return BigInt(totalAmount);
}
