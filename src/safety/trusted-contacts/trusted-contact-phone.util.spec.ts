import { normalizeTrustedContactPhone } from './trusted-contact-phone.util';

describe('normalizeTrustedContactPhone', () => {
  it('normalizes 10-digit Indian mobiles', () => {
    expect(normalizeTrustedContactPhone('9876543210')).toBe('+919876543210');
  });

  it('normalizes +91 and spaced forms', () => {
    expect(normalizeTrustedContactPhone('+91 98765 43210')).toBe(
      '+919876543210',
    );
    expect(normalizeTrustedContactPhone('919876543210')).toBe('+919876543210');
  });

  it('rejects invalid numbers', () => {
    expect(normalizeTrustedContactPhone('12345')).toBeNull();
    expect(normalizeTrustedContactPhone('5123456789')).toBeNull();
    expect(normalizeTrustedContactPhone('')).toBeNull();
    expect(normalizeTrustedContactPhone('   ')).toBeNull();
  });
});
