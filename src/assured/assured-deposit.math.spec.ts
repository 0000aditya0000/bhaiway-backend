import { calculateAssuredDepositAmount } from './assured-deposit.math';

describe('calculateAssuredDepositAmount (HALF UP)', () => {
  it('calculates exact percentages without remainder', () => {
    expect(calculateAssuredDepositAmount(2000n, 5)).toBe(100n);
    expect(calculateAssuredDepositAmount(500n, 5)).toBe(25n);
    expect(calculateAssuredDepositAmount(1000n, 5)).toBe(50n);
  });

  it('rounds .5 and above up', () => {
    // 333 * 5 = 1665 → 16.65 → 17
    expect(calculateAssuredDepositAmount(333n, 5)).toBe(17n);
    // 10 * 5 = 50 → 0.50 → 1
    expect(calculateAssuredDepositAmount(10n, 5)).toBe(1n);
  });

  it('rounds below .5 down', () => {
    // 329 * 5 = 1645 → 16.45 → 16
    expect(calculateAssuredDepositAmount(329n, 5)).toBe(16n);
    // 9 * 5 = 45 → 0.45 → 0
    expect(calculateAssuredDepositAmount(9n, 5)).toBe(0n);
  });

  it('supports changed admin percentage for future deposits', () => {
    expect(calculateAssuredDepositAmount(2000n, 7)).toBe(140n);
    expect(calculateAssuredDepositAmount(500n, 7)).toBe(35n);
  });

  it('rejects invalid percentage', () => {
    expect(() => calculateAssuredDepositAmount(100n, 0)).toThrow();
    expect(() => calculateAssuredDepositAmount(100n, 101)).toThrow();
    expect(() => calculateAssuredDepositAmount(100n, 5.5)).toThrow();
  });
});
