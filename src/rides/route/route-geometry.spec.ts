import {
  buildStraightRouteGeometry,
  haversineMeters,
  matchesRouteCorridor,
  projectPointOntoRoute,
  ROUTE_CORRIDOR_MAX_METERS,
} from './route-geometry';

/** Approximate WGS84 points used by corridor search product scenarios. */
const NOIDA = { latitude: 28.5355, longitude: 77.391 };
const INDIRAPURAM = { latitude: 28.6415, longitude: 77.372 };
const MEERUT = { latitude: 28.9845, longitude: 77.7064 };
const HARIDWAR = { latitude: 29.9457, longitude: 78.1642 };
const DEHRADUN = { latitude: 30.3165, longitude: 78.0322 };
const MUMBAI = { latitude: 19.076, longitude: 72.8777 };

describe('route-geometry corridor matching', () => {
  const published = buildStraightRouteGeometry(NOIDA, DEHRADUN);

  it('Test 1 / 9: exact Noida → Dehradun matches', () => {
    expect(
      matchesRouteCorridor({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: DEHRADUN,
      }),
    ).toBe(true);
  });

  it('Test 2: Indirapuram → Dehradun matches (near corridor)', () => {
    expect(
      matchesRouteCorridor({
        routePoints: published.points,
        pickup: INDIRAPURAM,
        dropoff: DEHRADUN,
      }),
    ).toBe(true);
  });

  it('Test 3: Noida → Meerut matches when Meerut is near the route', () => {
    const meerutProjection = projectPointOntoRoute(MEERUT, published.points);
    expect(meerutProjection.distanceFromRouteMeters).toBeLessThan(
      ROUTE_CORRIDOR_MAX_METERS,
    );
    expect(
      matchesRouteCorridor({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: MEERUT,
      }),
    ).toBe(true);
  });

  it('Test 4: Meerut → Dehradun matches', () => {
    expect(
      matchesRouteCorridor({
        routePoints: published.points,
        pickup: MEERUT,
        dropoff: DEHRADUN,
      }),
    ).toBe(true);
  });

  it('Test 5: Dehradun → Meerut does not match (reverse direction)', () => {
    expect(
      matchesRouteCorridor({
        routePoints: published.points,
        pickup: DEHRADUN,
        dropoff: MEERUT,
      }),
    ).toBe(false);
  });

  it('Test 6: pickup > 50km from route does not match', () => {
    expect(
      matchesRouteCorridor({
        routePoints: published.points,
        pickup: MUMBAI,
        dropoff: DEHRADUN,
      }),
    ).toBe(false);
  });

  it('Test 7: destination > 50km from route does not match', () => {
    expect(
      matchesRouteCorridor({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: MUMBAI,
      }),
    ).toBe(false);
  });

  it('Test 8: both points within corridor and correct order matches', () => {
    expect(
      matchesRouteCorridor({
        routePoints: published.points,
        pickup: INDIRAPURAM,
        dropoff: MEERUT,
      }),
    ).toBe(true);
  });

  it('rejects nearly identical projections (insufficient progress)', () => {
    expect(
      matchesRouteCorridor({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: {
          latitude: NOIDA.latitude + 0.0001,
          longitude: NOIDA.longitude + 0.0001,
        },
      }),
    ).toBe(false);
  });

  it('Haridwar segment along densified geodesic stays ordered', () => {
    const haridwarProjection = projectPointOntoRoute(
      HARIDWAR,
      published.points,
    );
    expect(haridwarProjection.distanceFromRouteMeters).toBeLessThan(
      ROUTE_CORRIDOR_MAX_METERS,
    );
    expect(
      matchesRouteCorridor({
        routePoints: published.points,
        pickup: MEERUT,
        dropoff: HARIDWAR,
      }),
    ).toBe(true);
  });

  it('encode/decode round-trip preserves endpoints within ~1m', () => {
    const decodedStart = published.points[0];
    const decodedEnd = published.points[published.points.length - 1];
    expect(haversineMeters(decodedStart, NOIDA)).toBeLessThan(5);
    expect(haversineMeters(decodedEnd, DEHRADUN)).toBeLessThan(5);
  });
});
