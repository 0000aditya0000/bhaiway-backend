const randomInt = jest.fn((min: number, max: number) =>
  jest.requireActual<typeof import('crypto')>('crypto').randomInt(min, max),
);

jest.mock('crypto', () => {
  const actual = jest.requireActual<typeof import('crypto')>('crypto');
  return {
    ...actual,
    randomInt: (min: number, max: number) => randomInt(min, max),
  };
});

import {
  emailOtpHashesMatch,
  generateEmailOtp,
  hashEmailOtp,
  isValidEmailOtpFormat,
  normalizeEmail,
} from './email-otp.util';

describe('email-otp.util', () => {
  const pepper = 'test-pepper-not-a-secret-for-prod';

  it('generates a 4-digit OTP in the range 1000-9999', () => {
    for (let i = 0; i < 20; i += 1) {
      const otp = generateEmailOtp();
      expect(otp).toMatch(/^\d{4}$/);
      expect(Number(otp)).toBeGreaterThanOrEqual(1000);
      expect(Number(otp)).toBeLessThanOrEqual(9999);
    }
  });

  it('uses crypto.randomInt rather than Math.random', () => {
    randomInt.mockClear();
    generateEmailOtp();
    expect(randomInt).toHaveBeenCalledWith(1000, 10_000);
  });

  it('stores a hash, not the plaintext OTP', () => {
    const otp = '4827';
    const hash = hashEmailOtp({
      otp,
      userId: 'user-1',
      email: 'user@example.com',
      pepper,
    });
    expect(hash).not.toContain(otp);
    expect(hash.startsWith('v1$')).toBe(true);
    expect(hash.split('$')).toHaveLength(3);
  });

  it('verifies a matching OTP and rejects a wrong OTP', () => {
    const otp = '4827';
    const hash = hashEmailOtp({
      otp,
      userId: 'user-1',
      email: 'user@example.com',
      pepper,
    });
    expect(
      emailOtpHashesMatch(hash, otp, 'user-1', 'user@example.com', pepper),
    ).toBe(true);
    expect(
      emailOtpHashesMatch(hash, '0000', 'user-1', 'user@example.com', pepper),
    ).toBe(false);
  });

  it('does not accept the same hash for a different user or email', () => {
    const hash = hashEmailOtp({
      otp: '4827',
      userId: 'user-1',
      email: 'user@example.com',
      pepper,
    });
    expect(
      emailOtpHashesMatch(hash, '4827', 'user-2', 'user@example.com', pepper),
    ).toBe(false);
    expect(
      emailOtpHashesMatch(hash, '4827', 'user-1', 'other@example.com', pepper),
    ).toBe(false);
  });

  it('normalizes email and validates OTP format', () => {
    expect(normalizeEmail('  Ada@Example.com ')).toBe('ada@example.com');
    expect(isValidEmailOtpFormat('4827')).toBe(true);
    expect(isValidEmailOtpFormat('0482')).toBe(true);
    expect(isValidEmailOtpFormat('482')).toBe(false);
    expect(isValidEmailOtpFormat('48271')).toBe(false);
    expect(isValidEmailOtpFormat('48a7')).toBe(false);
  });
});
