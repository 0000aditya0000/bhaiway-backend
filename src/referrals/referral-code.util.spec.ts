import {
  REFERRAL_CODE_PREFIX,
  REFERRAL_CODE_SUFFIX_LENGTH,
} from './enums/referral.enums';
import { generateReferralCode, normalizeReferralCode } from './referral-code.util';

describe('referral-code.util', () => {
  it('normalizes trim + uppercase', () => {
    expect(normalizeReferralCode(' bhw7k4p9 ')).toBe('BHW7K4P9');
  });

  it('treats blank as omitted', () => {
    expect(normalizeReferralCode('')).toBeNull();
    expect(normalizeReferralCode('   ')).toBeNull();
    expect(normalizeReferralCode(null)).toBeNull();
    expect(normalizeReferralCode(undefined)).toBeNull();
  });

  it('generates BHW + suffix codes', () => {
    const code = generateReferralCode();
    expect(code.startsWith(REFERRAL_CODE_PREFIX)).toBe(true);
    expect(code.length).toBe(
      REFERRAL_CODE_PREFIX.length + REFERRAL_CODE_SUFFIX_LENGTH,
    );
    expect(code).toBe(code.toUpperCase());
  });

  it('generates unique codes across many draws', () => {
    const set = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      set.add(generateReferralCode());
    }
    expect(set.size).toBe(200);
  });
});
