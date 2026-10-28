import {
  buildStraightRouteGeometry,
  finalizeRouteGeometry,
  haversineMeters,
  isPointBehindRouteSource,
  matchesRouteCorridor,
  matchesSelectedDriverRoute,
  projectPointOntoRoute,
  ROUTE_CORRIDOR_MAX_METERS,
  SELECTED_ROUTE_CORRIDOR_METERS,
  SELECTED_ROUTE_MIN_PROGRESS_METERS,
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

describe('selected-driver-route passenger matching', () => {
  const published = buildStraightRouteGeometry(NOIDA, DEHRADUN);
  const mid = projectPointOntoRoute(
    { latitude: 29.4, longitude: 77.7 },
    published.points,
  ).point;

  it('matches pickup within 50km of A in the first 50km of forward progress', () => {
    expect(
      matchesSelectedDriverRoute({
        routePoints: published.points,
        pickup: INDIRAPURAM,
        dropoff: DEHRADUN,
        source: NOIDA,
        destination: DEHRADUN,
      }),
    ).toBe(true);
  });

  it('rejects pickup within 50km of A but behind the source', () => {
    const behind = {
      latitude: NOIDA.latitude - 0.3,
      longitude: NOIDA.longitude,
    };
    expect(haversineMeters(behind, NOIDA)).toBeLessThan(50_000);
    expect(isPointBehindRouteSource(behind, published.points)).toBe(true);
    expect(
      matchesSelectedDriverRoute({
        routePoints: published.points,
        pickup: behind,
        dropoff: DEHRADUN,
        source: NOIDA,
        destination: DEHRADUN,
      }),
    ).toBe(false);
  });

  it('does not treat a later parallel branch near A as the source exception', () => {
    const farNorth = {
      latitude: NOIDA.latitude + 0.7,
      longitude: NOIDA.longitude,
    };
    const parallelNearA = {
      latitude: NOIDA.latitude + 0.01,
      longitude: NOIDA.longitude + 0.15,
    };
    const branched = finalizeRouteGeometry([
      NOIDA,
      farNorth,
      { latitude: farNorth.latitude, longitude: parallelNearA.longitude },
      parallelNearA,
      DEHRADUN,
    ]);
    expect(haversineMeters(parallelNearA, NOIDA)).toBeLessThan(50_000);
    expect(
      matchesSelectedDriverRoute({
        routePoints: branched.points,
        pickup: parallelNearA,
        dropoff: farNorth,
        source: NOIDA,
        destination: DEHRADUN,
      }),
    ).toBe(false);
  });

  it('does not apply the source exception to a later loop that returns near A', () => {
    const north = { latitude: NOIDA.latitude + 0.7, longitude: NOIDA.longitude };
    const loopNearA = {
      latitude: NOIDA.latitude + 0.01,
      longitude: NOIDA.longitude + 0.02,
    };
    const looped = finalizeRouteGeometry([NOIDA, north, loopNearA, DEHRADUN]);
    expect(
      matchesSelectedDriverRoute({
        routePoints: looped.points,
        pickup: loopNearA,
        dropoff: north,
        source: NOIDA,
        destination: DEHRADUN,
      }),
    ).toBe(false);
  });

  it('matches a pickup within 20km of the route and rejects one beyond 20km outside the source zone', () => {
    const onCorridor = {
      latitude: mid.latitude,
      longitude: mid.longitude + 0.02,
    };
    expect(
      haversineMeters(onCorridor, mid) < SELECTED_ROUTE_CORRIDOR_METERS,
    ).toBe(true);
    expect(
      matchesSelectedDriverRoute({
        routePoints: published.points,
        pickup: onCorridor,
        dropoff: DEHRADUN,
        source: NOIDA,
        destination: DEHRADUN,
      }),
    ).toBe(true);

    expect(
      matchesSelectedDriverRoute({
        routePoints: published.points,
        pickup: MUMBAI,
        dropoff: DEHRADUN,
        source: NOIDA,
        destination: DEHRADUN,
      }),
    ).toBe(false);
  });

  it('requires dropoff within 20km and not beyond B', () => {
    expect(
      matchesSelectedDriverRoute({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: DEHRADUN,
        source: NOIDA,
        destination: DEHRADUN,
      }),
    ).toBe(true);
    expect(
      matchesSelectedDriverRoute({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: MUMBAI,
        source: NOIDA,
        destination: DEHRADUN,
      }),
    ).toBe(false);

    const pastDestination = {
      latitude: DEHRADUN.latitude + 0.4,
      longitude: DEHRADUN.longitude + 0.15,
    };
    expect(
      matchesSelectedDriverRoute({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: pastDestination,
        source: NOIDA,
        destination: DEHRADUN,
      }),
    ).toBe(false);
  });

  it('rejects reverse searches, reverse mid-route, and dropoff before pickup', () => {
    expect(
      matchesSelectedDriverRoute({
        routePoints: published.points,
        pickup: DEHRADUN,
        dropoff: NOIDA,
        source: NOIDA,
        destination: DEHRADUN,
      }),
    ).toBe(false);
    expect(
      matchesSelectedDriverRoute({
        routePoints: published.points,
        pickup: DEHRADUN,
        dropoff: MEERUT,
        source: NOIDA,
        destination: DEHRADUN,
      }),
    ).toBe(false);
    expect(
      matchesSelectedDriverRoute({
        routePoints: published.points,
        pickup: DEHRADUN,
        dropoff: INDIRAPURAM,
        source: NOIDA,
        destination: DEHRADUN,
      }),
    ).toBe(false);
  });

  it('rejects near-identical pickup and dropoff via min progress', () => {
    expect(SELECTED_ROUTE_MIN_PROGRESS_METERS).toBe(100);
    expect(
      matchesSelectedDriverRoute({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: NOIDA,
        source: NOIDA,
        destination: DEHRADUN,
      }),
    ).toBe(false);
  });

  it('matches mid-route pickup to a later dropoff', () => {
    expect(
      matchesSelectedDriverRoute({
        routePoints: published.points,
        pickup: mid,
        dropoff: DEHRADUN,
        source: NOIDA,
        destination: DEHRADUN,
      }),
    ).toBe(true);
  });

  it('does not match missing geometry via a silent fallback', () => {
    expect(
      matchesSelectedDriverRoute({
        routePoints: [],
        pickup: NOIDA,
        dropoff: DEHRADUN,
        source: NOIDA,
        destination: DEHRADUN,
      }),
    ).toBe(false);
  });
});
