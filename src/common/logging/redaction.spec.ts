import {
  normalizeRoutePath,
  pickAllowlistedFields,
  redactSensitive,
} from './redaction';

describe('redaction', () => {
  it('redacts nested secret and PII keys', () => {
    const result = redactSensitive({
      bookingId: 'b-1',
      seats: 2,
      password: 'hunter2',
      otp: '123456',
      accessToken: 'jwt-secret',
      authorization: 'Bearer abc',
      nested: {
        refreshToken: 'r',
        aadhaarNumber: '9999',
        upiId: 'user@upi',
        phone: '+919999999999',
        email: 'a@b.com',
        safe: 'ok',
      },
      cookie: 'session=1',
      razorpay_signature: 'sig',
    }) as Record<string, unknown>;

    expect(result.bookingId).toBe('b-1');
    expect(result.seats).toBe(2);
    expect(result.password).toBe('[REDACTED]');
    expect(result.otp).toBe('[REDACTED]');
    expect(result.accessToken).toBe('[REDACTED]');
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.cookie).toBe('[REDACTED]');
    expect(result.razorpay_signature).toBe('[REDACTED]');
    const nested = result.nested as Record<string, unknown>;
    expect(nested.refreshToken).toBe('[REDACTED]');
    expect(nested.aadhaarNumber).toBe('[REDACTED]');
    expect(nested.upiId).toBe('[REDACTED]');
    expect(nested.phone).toBe('[REDACTED]');
    expect(nested.email).toBe('[REDACTED]');
    expect(nested.safe).toBe('ok');
  });

  it('never dumps full path identifiers when normalizing unmatched routes', () => {
    expect(
      normalizeRoutePath(
        '/bookings/550e8400-e29b-41d4-a716-446655440000?token=secret',
      ),
    ).toBe('/bookings/:id');
  });

  it('prefers Express route templates', () => {
    expect(normalizeRoutePath('/bookings/xyz', '/:id', '/bookings')).toBe(
      '/bookings/:id',
    );
  });

  it('allowlists only safe fields', () => {
    const picked = pickAllowlistedFields(
      {
        seats: 1,
        paymentMethod: 'PAY_NOW',
        password: 'nope',
        otp: '111111',
      },
      ['seats', 'paymentMethod', 'password'],
    );
    expect(picked).toEqual({ seats: 1, paymentMethod: 'PAY_NOW' });
  });
});
