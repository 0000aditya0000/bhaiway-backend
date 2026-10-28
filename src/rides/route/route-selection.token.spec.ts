import { randomUUID } from 'crypto';

import { buildStraightRouteGeometry } from './route-geometry';
import {
  ROUTE_SELECTION_TOKEN_VERSION,
  RouteSelectionTokenError,
  signRouteSelectionToken,
  verifyRouteSelectionToken,
} from './route-selection.token';

const SECRET = 'test-route-selection-secret';
const NOIDA = { latitude: 28.5355, longitude: 77.391 };
const DELHI = { latitude: 28.6139, longitude: 77.209 };

function payload(overrides: Record<string, unknown> = {}) {
  const geometry = buildStraightRouteGeometry(NOIDA, DELHI);
  return {
    v: ROUTE_SELECTION_TOKEN_VERSION,
    id: randomUUID(),
    slat: NOIDA.latitude,
    slng: NOIDA.longitude,
    dlat: DELHI.latitude,
    dlng: DELHI.longitude,
    poly: geometry.polylineEncoded,
    len: geometry.lengthMeters,
    dur: 2400,
    bbox: geometry.bbox,
    exp: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  };
}

describe('route-selection token', () => {
  it('round-trips a valid token', () => {
    const signed = signRouteSelectionToken(payload(), SECRET);
    const verified = verifyRouteSelectionToken(signed, SECRET);
    expect(verified.slat).toBe(NOIDA.latitude);
    expect(verified.poly.length).toBeGreaterThan(8);
  });

  it('rejects a tampered payload', () => {
    const signed = signRouteSelectionToken(payload(), SECRET);
    const [body, signature] = signed.split('.');
    const tampered = `x${body.slice(1)}.${signature}`;
    expect(() => verifyRouteSelectionToken(tampered, SECRET)).toThrow(
      RouteSelectionTokenError,
    );
  });

  it('rejects an expired token', () => {
    const signed = signRouteSelectionToken(
      payload({ exp: Math.floor(Date.now() / 1000) - 10 }),
      SECRET,
    );
    expect(() => verifyRouteSelectionToken(signed, SECRET)).toThrow(
      /expired/i,
    );
  });

  it('rejects a token signed with a different secret', () => {
    const signed = signRouteSelectionToken(payload(), SECRET);
    expect(() => verifyRouteSelectionToken(signed, 'other-secret-value')).toThrow(
      RouteSelectionTokenError,
    );
  });
});
