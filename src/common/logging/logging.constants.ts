export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const RESPONSE_REQUEST_ID_HEADER = 'X-Request-Id';
export const RESPONSE_CORRELATION_ID_HEADER = 'X-Correlation-Id';

export const SERVICE_NAME = 'bhaiway-api';

/** Max accepted length for client-supplied request/correlation IDs. */
export const MAX_TRACE_ID_LENGTH = 64;

/**
 * Client-supplied IDs must be UUID or safe opaque tokens
 * (alphanumeric, underscore, hyphen, colon). Reject everything else.
 */
export const TRACE_ID_PATTERN = /^[A-Za-z0-9_.:-]{8,64}$/;

export const SENSITIVE_FIELD_KEYS = [
  'password',
  'passwordHash',
  'pin',
  'otp',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'cookies',
  'apiKey',
  'apikey',
  'secret',
  'privateKey',
  'clientSecret',
  'webhookSecret',
  'signature',
  'x-signature',
  'x-razorpay-signature',
  'razorpay_signature',
  'aadhaar',
  'aadhaarNumber',
  'pan',
  'bankAccount',
  'accountNumber',
  'ifsc',
  'upi',
  'upiId',
  'phone',
  'email',
  'latitude',
  'longitude',
  'location',
  'firebase',
  'serviceAccount',
  'credential',
  'credentials',
  'token',
  'idToken',
  'rawBody',
  'documentUrl',
  'file',
  'files',
] as const;
