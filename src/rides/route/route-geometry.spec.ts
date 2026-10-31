import {
  buildStraightRouteGeometry,
  evaluateFlexibleDriverRouteMatch,
  finalizeRouteGeometry,
  haversineMeters,
  isPointBehindRouteSource,
  matchesRouteCorridor,
  matchesSelectedDriverRoute,
  projectPointOntoRoute,
  RideMatchCategory,
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
    const north = {
      latitude: NOIDA.latitude + 0.7,
      longitude: NOIDA.longitude,
    };
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

describe('flexible route matching (backward pickup and destination extension)', () => {
  const published = buildStraightRouteGeometry(NOIDA, DEHRADUN);

  // Calculated backward pickup coordinates along line of travel from NOIDA:
  const pickup5kmBehind = { latitude: 28.4932, longitude: 77.3737 };
  const pickup15kmBehind = { latitude: 28.4087, longitude: 77.3391 };
  const pickup25kmBehind = { latitude: 28.3242, longitude: 77.3045 };
  const pickup30kmBehind = { latitude: 28.2819, longitude: 77.2872 };
  const pickup35kmBehind = { latitude: 28.2397, longitude: 77.2699 };

  // Calculated extended destination coordinates along line of travel from DEHRADUN:
  const dest10kmBeyond = { latitude: 30.401, longitude: 78.0674 };
  const dest25kmBeyond = { latitude: 30.5278, longitude: 78.1202 };
  const dest45kmBeyond = { latitude: 30.6968, longitude: 78.1906 };
  const dest50kmBeyond = { latitude: 30.739, longitude: 78.2082 };
  const dest55kmBeyond = { latitude: 30.7813, longitude: 78.2258 };

  describe('Backward pickup', () => {
    it('matches pickup 5 km behind driver source', () => {
      expect(haversineMeters(pickup5kmBehind, NOIDA)).toBeCloseTo(5000, -2);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: pickup5kmBehind,
        dropoff: DEHRADUN,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).not.toBeNull();
      expect(res?.category).toBe(RideMatchCategory.BACKWARD_PICKUP_MATCH);
      expect(res?.isFlexible).toBe(true);
      expect(res?.requiresIndependentPickupTravel).toBe(true);
      expect(res?.requiresIndependentDestinationTravel).toBe(false);
      expect(res?.pickupFlexibilityDistanceKm).toBeCloseTo(5.0, 0);
      expect(res?.destinationExtensionDistanceKm).toBeNull();
    });

    it('matches pickup 15 km behind driver source', () => {
      expect(haversineMeters(pickup15kmBehind, NOIDA)).toBeCloseTo(15000, -2);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: pickup15kmBehind,
        dropoff: DEHRADUN,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).not.toBeNull();
      expect(res?.category).toBe(RideMatchCategory.BACKWARD_PICKUP_MATCH);
      expect(res?.pickupFlexibilityDistanceKm).toBeCloseTo(15.0, 0);
    });

    it('matches pickup 25 km behind driver source', () => {
      expect(haversineMeters(pickup25kmBehind, NOIDA)).toBeCloseTo(25000, -2);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: pickup25kmBehind,
        dropoff: DEHRADUN,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).not.toBeNull();
      expect(res?.category).toBe(RideMatchCategory.BACKWARD_PICKUP_MATCH);
      expect(res?.pickupFlexibilityDistanceKm).toBeCloseTo(25.0, 0);
    });

    it('matches pickup exactly 30 km away', () => {
      expect(haversineMeters(pickup30kmBehind, NOIDA)).toBeCloseTo(30000, -2);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: pickup30kmBehind,
        dropoff: DEHRADUN,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).not.toBeNull();
      expect(res?.category).toBe(RideMatchCategory.BACKWARD_PICKUP_MATCH);
      expect(res?.pickupFlexibilityDistanceKm).toBeCloseTo(30.0, 0);
    });

    it('rejects pickup beyond 30 km (> 30 km allowance)', () => {
      expect(haversineMeters(pickup35kmBehind, NOIDA)).toBeGreaterThan(30000);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: pickup35kmBehind,
        dropoff: DEHRADUN,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).toBeNull();
    });

    it('rejects pickup geographically close but unrelated (> 20km perpendicular from route line)', () => {
      const lateralFar = {
        latitude: NOIDA.latitude,
        longitude: NOIDA.longitude - 0.28,
      };
      expect(haversineMeters(lateralFar, NOIDA)).toBeLessThan(30000);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: lateralFar,
        dropoff: DEHRADUN,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).toBeNull();
    });

    it('rejects pickup requiring the driver to reverse direction', () => {
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: DEHRADUN,
        dropoff: NOIDA,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).toBeNull();
    });
  });

  describe('Destination extension', () => {
    it('matches destination 10 km beyond driver destination', () => {
      expect(haversineMeters(dest10kmBeyond, DEHRADUN)).toBeCloseTo(10000, -2);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: dest10kmBeyond,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).not.toBeNull();
      expect(res?.category).toBe(RideMatchCategory.EXTENDED_DESTINATION_MATCH);
      expect(res?.isFlexible).toBe(true);
      expect(res?.requiresIndependentPickupTravel).toBe(false);
      expect(res?.requiresIndependentDestinationTravel).toBe(true);
      expect(res?.destinationExtensionDistanceKm).toBeCloseTo(10.0, 0);
      expect(res?.pickupFlexibilityDistanceKm).toBeNull();
    });

    it('matches destination 25 km beyond driver destination', () => {
      expect(haversineMeters(dest25kmBeyond, DEHRADUN)).toBeCloseTo(25000, -2);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: dest25kmBeyond,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).not.toBeNull();
      expect(res?.category).toBe(RideMatchCategory.EXTENDED_DESTINATION_MATCH);
      expect(res?.destinationExtensionDistanceKm).toBeCloseTo(25.0, 0);
    });

    it('matches destination 45 km beyond driver destination', () => {
      expect(haversineMeters(dest45kmBeyond, DEHRADUN)).toBeCloseTo(45000, -3);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: dest45kmBeyond,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).not.toBeNull();
      expect(res?.category).toBe(RideMatchCategory.EXTENDED_DESTINATION_MATCH);
      expect(res?.destinationExtensionDistanceKm).toBeCloseTo(45.0, 0);
    });

    it('matches destination exactly 50 km beyond driver destination', () => {
      expect(haversineMeters(dest50kmBeyond, DEHRADUN)).toBeCloseTo(50000, -3);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: dest50kmBeyond,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).not.toBeNull();
      expect(res?.category).toBe(RideMatchCategory.EXTENDED_DESTINATION_MATCH);
      expect(res?.destinationExtensionDistanceKm).toBeCloseTo(50.0, 0);
    });

    it('rejects destination beyond 50 km (> 50 km allowance)', () => {
      expect(haversineMeters(dest55kmBeyond, DEHRADUN)).toBeGreaterThan(50000);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: dest55kmBeyond,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).toBeNull();
    });

    it('rejects destination close to driver destination but in an unrelated direction (> 20km perpendicular)', () => {
      const unrelated = {
        latitude: DEHRADUN.latitude,
        longitude: DEHRADUN.longitude + 0.35,
      };
      expect(haversineMeters(unrelated, DEHRADUN)).toBeLessThan(50000);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: unrelated,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).toBeNull();
    });

    it('rejects destination requiring reverse direction (doubling back toward source)', () => {
      const reversePoint = {
        latitude: DEHRADUN.latitude - 0.17,
        longitude: DEHRADUN.longitude - 0.07,
      };
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: HARIDWAR,
        dropoff: reversePoint,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).toBeNull();
    });
  });

  describe('Combined flexibility', () => {
    it('matches pickup behind source and destination beyond driver destination', () => {
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: pickup15kmBehind,
        dropoff: dest25kmBeyond,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).not.toBeNull();
      expect(res?.category).toBe(
        RideMatchCategory.FLEXIBLE_PICKUP_AND_DESTINATION_MATCH,
      );
      expect(res?.isFlexible).toBe(true);
      expect(res?.requiresIndependentPickupTravel).toBe(true);
      expect(res?.requiresIndependentDestinationTravel).toBe(true);
      expect(res?.pickupFlexibilityDistanceKm).toBeCloseTo(15.0, 0);
      expect(res?.destinationExtensionDistanceKm).toBeCloseTo(25.0, 0);
    });

    it('rejects when pickup is within 30 km but destination is beyond 50 km (no compensation)', () => {
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: pickup15kmBehind,
        dropoff: dest55kmBeyond,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).toBeNull();
    });

    it('rejects when pickup is beyond 30 km but destination is within 50 km (no compensation)', () => {
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: pickup35kmBehind,
        dropoff: dest25kmBeyond,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).toBeNull();
    });

    it('matches when both distances are exactly at their respective limits (30km and 50km)', () => {
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: pickup30kmBehind,
        dropoff: dest50kmBeyond,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).not.toBeNull();
      expect(res?.category).toBe(
        RideMatchCategory.FLEXIBLE_PICKUP_AND_DESTINATION_MATCH,
      );
      expect(res?.pickupFlexibilityDistanceKm).toBeCloseTo(30.0, 0);
      expect(res?.destinationExtensionDistanceKm).toBeCloseTo(50.0, 0);
    });

    it('rejects when both distances are beyond their respective limits', () => {
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: pickup35kmBehind,
        dropoff: dest55kmBeyond,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).toBeNull();
    });
  });

  describe('Existing behaviour and safeguards', () => {
    it('normal forward-route match returns FORWARD_ROUTE_MATCH with isFlexible: false', () => {
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: DEHRADUN,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).not.toBeNull();
      expect(res?.category).toBe(RideMatchCategory.FORWARD_ROUTE_MATCH);
      expect(res?.isFlexible).toBe(false);
      expect(res?.pickupFlexibilityDistanceKm).toBeNull();
      expect(res?.destinationExtensionDistanceKm).toBeNull();
    });

    it('reverse-direction journey remains rejected', () => {
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: published.points,
        pickup: DEHRADUN,
        dropoff: MEERUT,
        source: NOIDA,
        destination: DEHRADUN,
      });
      expect(res).toBeNull();
    });
  });
});
