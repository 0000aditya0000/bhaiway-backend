import { uniqueIdempotencyKey } from '../../wallet/test/wallet-test.helpers';

/**
 * Default endpoint coordinates for Assured integration tests.
 * Straight-line route geometry is derived at publish time from these coords.
 */
export const ASSURED_TEST_ROUTE = {
  sourceLatitude: 28.5355,
  sourceLongitude: 77.391,
  destinationLatitude: 28.6139,
  destinationLongitude: 77.209,
};

export function withAssuredTestRoute<T extends Record<string, unknown>>(
  payload: T,
): T & typeof ASSURED_TEST_ROUTE {
  return {
    ...ASSURED_TEST_ROUTE,
    ...payload,
  };
}

/** Auth + required Idempotency-Key for Assured POST /rides. */
export function withAssuredPublishHeaders(
  accessToken: string,
  idempotencyKey?: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Idempotency-Key':
      idempotencyKey ?? uniqueIdempotencyKey('assured-publish'),
  };
}
