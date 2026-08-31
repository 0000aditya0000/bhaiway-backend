import {
  calculatePartialFillCompensation,
  distributeEvenlyWithRemainder,
  percentOfAmountHalfUp,
} from './assured-lifecycle.math';

describe('assured-lifecycle.math', () => {
  it('computes 60% with HALF UP', () => {
    expect(percentOfAmountHalfUp(100n, 60)).toBe(60n);
    expect(percentOfAmountHalfUp(101n, 60)).toBe(61n); // 60.6 → 61
  });

  it('distributes remainder deterministically', () => {
    expect(distributeEvenlyWithRemainder(61n, 2)).toEqual([31n, 30n]);
    expect(distributeEvenlyWithRemainder(60n, 2)).toEqual([30n, 30n]);
    expect(distributeEvenlyWithRemainder(100n, 0)).toEqual([]);
  });

  it('computes 30% passenger-cancel fare driver share with HALF UP', () => {
    expect(percentOfAmountHalfUp(700n, 30)).toBe(210n);
    expect(700n - percentOfAmountHalfUp(700n, 30)).toBe(490n);
  });

  it('calculates partial-fill with seat cap and ₹700 max', () => {
    expect(calculatePartialFillCompensation(1, 500n)).toBe(250n);
    expect(calculatePartialFillCompensation(2, 500n)).toBe(500n);
    expect(calculatePartialFillCompensation(3, 500n)).toBe(500n); // only 2 seats
    expect(calculatePartialFillCompensation(2, 1000n)).toBe(700n); // capped
    expect(calculatePartialFillCompensation(0, 500n)).toBe(0n);
  });
});
