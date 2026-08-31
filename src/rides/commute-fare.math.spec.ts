import {
  COMMUTE_RIDER_MARKUP_PERCENT,
  computeCommuteBookingFareSnapshots,
  computeCommuteRiderPricePerSeat,
} from './commute-fare.math';

describe('commute-fare.math', () => {
  it('applies 10% markup with integer HALF UP', () => {
    expect(computeCommuteRiderPricePerSeat(100n)).toBe('110');
    expect(computeCommuteRiderPricePerSeat('250')).toBe('275');
    expect(computeCommuteRiderPricePerSeat('500')).toBe('550');
    expect(computeCommuteRiderPricePerSeat('700')).toBe('770');
    expect(computeCommuteRiderPricePerSeat('333')).toBe('366');
  });

  it('exposes fixed 10% markup constant', () => {
    expect(COMMUTE_RIDER_MARKUP_PERCENT).toBe(10);
  });

  it('computes booking fare snapshots for multi-seat requests', () => {
    expect(computeCommuteBookingFareSnapshots('100', 2)).toEqual({
      driverPricePerSeatSnapshot: '100',
      riderPricePerSeatSnapshot: '110',
      driverShareAmount: '200',
      platformShareAmount: '20',
      totalAmount: '220',
    });
  });
});
