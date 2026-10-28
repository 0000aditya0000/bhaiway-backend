import { uniqueIdempotencyKey } from '../../wallet/test/wallet-test.helpers';
import { withSelectedRoute } from './selected-route-test.helpers';

/**
 * Default endpoint coordinates for Assured integration tests.
 * Publish payloads should go through {@link withAssuredTestRoute} so a signed
 * selected-route token is attached.
 */
export const ASSURED_TEST_ROUTE = {
  sourceLatitude: 28.5355,
  sourceLongitude: 77.391,
  destinationLatitude: 28.6139,
  destinationLongitude: 77.209,
};

export function withAssuredTestRoute<T extends Record<string, unknown>>(
  payload: T,
): T &
  typeof ASSURED_TEST_ROUTE & {
    routeSelectionToken: string;
  } {
  return withSelectedRoute({
    sourceLatitude: ASSURED_TEST_ROUTE.sourceLatitude,
    sourceLongitude: ASSURED_TEST_ROUTE.sourceLongitude,
    destinationLatitude: ASSURED_TEST_ROUTE.destinationLatitude,
    destinationLongitude: ASSURED_TEST_ROUTE.destinationLongitude,
    ...payload,
  });
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
