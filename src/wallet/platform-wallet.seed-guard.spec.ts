import { shouldSeedPlatformOpeningFloat } from './platform-wallet.service';

describe('shouldSeedPlatformOpeningFloat', () => {
  it('seeds only a canonical wallet with no lots and no ledger history', () => {
    expect(
      shouldSeedPlatformOpeningFloat({
        lotCount: 0,
        hasOpeningFloatLedger: false,
        hasAnyPlatformLedger: false,
      }),
    ).toBe(true);
  });

  it('does not seed when lots already exist', () => {
    expect(
      shouldSeedPlatformOpeningFloat({
        lotCount: 1,
        hasOpeningFloatLedger: false,
        hasAnyPlatformLedger: false,
      }),
    ).toBe(false);
  });

  it('does not seed when the opening-float ledger already exists', () => {
    expect(
      shouldSeedPlatformOpeningFloat({
        lotCount: 0,
        hasOpeningFloatLedger: true,
        hasAnyPlatformLedger: true,
      }),
    ).toBe(false);
  });

  it('does not seed when any platform ledger exists', () => {
    expect(
      shouldSeedPlatformOpeningFloat({
        lotCount: 0,
        hasOpeningFloatLedger: false,
        hasAnyPlatformLedger: true,
      }),
    ).toBe(false);
  });
});
