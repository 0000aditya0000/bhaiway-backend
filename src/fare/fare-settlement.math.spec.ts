import {
  fareSettlementDriverCreditKey,
  fareSettlementPassengerDebitKey,
  parseFareAmount,
} from './fare-settlement.math';

describe('fare-settlement.math', () => {
  it('builds deterministic idempotency keys', () => {
    const bookingId = '11111111-1111-4111-8111-111111111111';
    expect(fareSettlementPassengerDebitKey(bookingId)).toBe(
      'fare-settle:passenger-debit:11111111-1111-4111-8111-111111111111',
    );
    expect(fareSettlementDriverCreditKey(bookingId)).toBe(
      'fare-settle:driver-credit:11111111-1111-4111-8111-111111111111',
    );
  });

  it('parses fare amounts as bigint', () => {
    expect(parseFareAmount('500')).toBe(500n);
  });
});
