import { maskEmail, maskPhone, maskRegistration } from './admin-privacy.util';

describe('admin-privacy.util', () => {
  it('masks phone keeping last 4 digits', () => {
    expect(maskPhone('+919876543210')).toBe('********3210');
  });

  it('masks email local part', () => {
    expect(maskEmail('rahul@example.com')).toBe('r***@example.com');
  });

  it('masks registration keeping last 4', () => {
    expect(maskRegistration('KA01AB1234')).toBe('******1234');
  });
});
