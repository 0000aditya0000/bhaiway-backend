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

  describe('Audited Geographic Accuracy & Diagonal Boundaries', () => {
    // Route from South to North: (28.0, 77.0) -> (30.0, 77.0)
    const southSource = { latitude: 28.0, longitude: 77.0 };
    const midPoint = { latitude: 29.0, longitude: 77.0 };
    const northDest = { latitude: 30.0, longitude: 77.0 };
    const straightRoute = [southSource, midPoint, northDest];

    it('matches pickup 10 km directly behind source', () => {
      const p10km = { latitude: 28.0 - 10 / 111.32, longitude: 77.0 };
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: straightRoute,
        pickup: p10km,
        dropoff: northDest,
      });
      expect(res?.category).toBe(RideMatchCategory.BACKWARD_PICKUP_MATCH);
      expect(res?.pickupFlexibilityDistanceKm).toBeCloseTo(10.0, 0);
    });

    it('matches pickup 25 km directly behind source', () => {
      const p25km = { latitude: 28.0 - 25 / 111.32, longitude: 77.0 };
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: straightRoute,
        pickup: p25km,
        dropoff: northDest,
      });
      expect(res?.category).toBe(RideMatchCategory.BACKWARD_PICKUP_MATCH);
      expect(res?.pickupFlexibilityDistanceKm).toBeCloseTo(25.0, 0);
    });

    it('rejects pickup 29 km from source diagonally when lateral offset exceeds 20 km corridor', () => {
      // 20 km backward, 21 km lateral (dist ~ 29.0 km <= 30 km, but lateral 21 km > 20 km corridor)
      const p29kmDiagFar = {
        latitude: 28.0 - 20 / 111.32,
        longitude: 77.0 + 21 / 98.0,
      };
      const dist = haversineMeters(p29kmDiagFar, southSource);
      expect(dist).toBeLessThanOrEqual(30000);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: straightRoute,
        pickup: p29kmDiagFar,
        dropoff: northDest,
      });
      // Rejected due to perpDist > SELECTED_ROUTE_CORRIDOR_METERS (20km)
      expect(res).toBeNull();
    });

    it('matches pickup 29 km from source diagonally when lateral offset is within 20 km corridor', () => {
      // 25 km backward, 14 km lateral (dist ~ 28.7 km <= 30 km, lateral 14 km <= 20 km)
      const p29kmDiagNear = {
        latitude: 28.0 - 25 / 111.32,
        longitude: 77.0 + 14 / 98.0,
      };
      const dist = haversineMeters(p29kmDiagNear, southSource);
      expect(dist).toBeLessThanOrEqual(30000);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: straightRoute,
        pickup: p29kmDiagNear,
        dropoff: northDest,
      });
      expect(res?.category).toBe(RideMatchCategory.BACKWARD_PICKUP_MATCH);
      expect(res?.pickupFlexibilityDistanceKm).toBeCloseTo(28.7, 0);
    });

    it('rejects pickup 31 km from source', () => {
      const p31km = { latitude: 28.0 - 31 / 111.32, longitude: 77.0 };
      expect(haversineMeters(p31km, southSource)).toBeGreaterThan(30000);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: straightRoute,
        pickup: p31km,
        dropoff: northDest,
      });
      expect(res).toBeNull();
    });

    it('rejects pickup within 30 km but geographically unrelated (behind dropoff progress requirement)', () => {
      // Loop route returning south where south point is actually closer to dropoff than source
      const loopRoute = [
        southSource,
        { latitude: 28.5, longitude: 77.0 },
        { latitude: 28.2, longitude: 77.0 },
      ];
      // Pickup 10km south is closer to dropoff (28.2) than source is (28.0)
      const pBehind = { latitude: 28.0 - 10 / 111.32, longitude: 77.0 };
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: loopRoute,
        pickup: pBehind,
        dropoff: { latitude: 27.8, longitude: 77.0 },
      });
      expect(res).toBeNull();
    });

    it('matches destination 15 km beyond driver destination', () => {
      const d15km = { latitude: 30.0 + 15 / 111.32, longitude: 77.0 };
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: straightRoute,
        pickup: southSource,
        dropoff: d15km,
      });
      expect(res?.category).toBe(RideMatchCategory.EXTENDED_DESTINATION_MATCH);
      expect(res?.destinationExtensionDistanceKm).toBeCloseTo(15.0, 0);
    });

    it('matches destination 30 km beyond driver destination', () => {
      const d30km = { latitude: 30.0 + 30 / 111.32, longitude: 77.0 };
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: straightRoute,
        pickup: southSource,
        dropoff: d30km,
      });
      expect(res?.category).toBe(RideMatchCategory.EXTENDED_DESTINATION_MATCH);
      expect(res?.destinationExtensionDistanceKm).toBeCloseTo(30.0, 0);
    });

    it('matches destination 49 km beyond driver destination', () => {
      const d49km = { latitude: 30.0 + 49 / 111.32, longitude: 77.0 };
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: straightRoute,
        pickup: southSource,
        dropoff: d49km,
      });
      expect(res?.category).toBe(RideMatchCategory.EXTENDED_DESTINATION_MATCH);
      expect(res?.destinationExtensionDistanceKm).toBeCloseTo(49.0, 0);
    });

    it('rejects destination 51 km beyond driver destination', () => {
      const d51km = { latitude: 30.0 + 51 / 111.32, longitude: 77.0 };
      expect(haversineMeters(d51km, northDest)).toBeGreaterThan(50000);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: straightRoute,
        pickup: southSource,
        dropoff: d51km,
      });
      expect(res).toBeNull();
    });

    it('rejects destination 30 km diagonally away when lateral offset exceeds 20 km corridor', () => {
      // 21km forward, 21.4km lateral (dist ~ 29.9km <= 50km, but lateral 21.4km > 20km corridor)
      const d30kmDiagFar = {
        latitude: 30.0 + 21 / 111.32,
        longitude: 77.0 + 21.4 / 96.5,
      };
      const dist = haversineMeters(d30kmDiagFar, northDest);
      expect(dist).toBeLessThanOrEqual(50000);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: straightRoute,
        pickup: southSource,
        dropoff: d30kmDiagFar,
      });
      // Rejected due to perpDist > SELECTED_ROUTE_CORRIDOR_METERS (20km)
      expect(res).toBeNull();
    });

    it('matches destination 30 km diagonally away when lateral offset is within 20 km corridor', () => {
      // 26km forward, 14km lateral (dist ~ 29.5km <= 50km, lateral 14km <= 20km corridor)
      const d30kmDiagNear = {
        latitude: 30.0 + 26 / 111.32,
        longitude: 77.0 + 14 / 96.5,
      };
      const dist = haversineMeters(d30kmDiagNear, northDest);
      expect(dist).toBeLessThanOrEqual(50000);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: straightRoute,
        pickup: southSource,
        dropoff: d30kmDiagNear,
      });
      expect(res?.category).toBe(RideMatchCategory.EXTENDED_DESTINATION_MATCH);
      expect(res?.destinationExtensionDistanceKm).toBeCloseTo(29.5, 0);
    });

    it('rejects destination 25 km away in an unrelated direction (90 degrees sideways East)', () => {
      // Pure East: 0 km forward, 25 km lateral (outside forward continuation cone cosAngle >= 0.25)
      const d25kmSideways = {
        latitude: 30.0,
        longitude: 77.0 + 25 / 96.5,
      };
      const dist = haversineMeters(d25kmSideways, northDest);
      expect(dist).toBeLessThan(50000);
      const res = evaluateFlexibleDriverRouteMatch({
        routePoints: straightRoute,
        pickup: southSource,
        dropoff: d25kmSideways,
      });
      expect(res).toBeNull();
    });
  });

  describe('road-network distance validation for flexible route matching (Section 10)', () => {
    const routeStart = { latitude: 28.5355, longitude: 77.391 }; // Noida
    const routeEnd = { latitude: 30.3165, longitude: 78.0322 }; // Dehradun
    const straightRoute = [routeStart, routeEnd];

    describe('Backward pickup road distance validation (30 km limit)', () => {
      // Behind routeStart (south)
      const p10km = { latitude: 28.5355 - 10 / 111.32, longitude: 77.391 };
      const p15km = { latitude: 28.5355 - 15 / 111.32, longitude: 77.391 };
      const p20km = { latitude: 28.5355 - 20 / 111.32, longitude: 77.391 };
      const p25km = { latitude: 28.5355 - 25 / 111.32, longitude: 77.391 };

      it('Straight-line distance 10 km, road distance 12 km: accept', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: p10km,
          dropoff: routeEnd,
          verifiedBackwardPickupRoadDistanceMeters: 12000,
          distanceCalculationMethod: 'ROAD_NETWORK',
          routingProvider: 'google',
        });
        expect(res).not.toBeNull();
        expect(res?.category).toBe(RideMatchCategory.BACKWARD_PICKUP_MATCH);
        expect(res?.pickupFlexibilityDistanceKm).toBe(12.0);
        expect(res?.distanceCalculationMethod).toBe('ROAD_NETWORK');
        expect(res?.roadDistanceVerified).toBe(true);
        expect(res?.routingProvider).toBe('google');
      });

      it('Straight-line distance 15 km, road distance 25 km: accept', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: p15km,
          dropoff: routeEnd,
          verifiedBackwardPickupRoadDistanceMeters: 25000,
        });
        expect(res).not.toBeNull();
        expect(res?.category).toBe(RideMatchCategory.BACKWARD_PICKUP_MATCH);
        expect(res?.pickupFlexibilityDistanceKm).toBe(25.0);
        expect(res?.roadDistanceVerified).toBe(true);
      });

      it('Straight-line distance 20 km, road distance 35 km: reject (> 30 km)', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: p20km,
          dropoff: routeEnd,
          verifiedBackwardPickupRoadDistanceMeters: 35000,
        });
        expect(res).toBeNull();
      });

      it('Straight-line distance 25 km, road distance 29 km: accept if directional and corridor conditions pass', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: p25km,
          dropoff: routeEnd,
          verifiedBackwardPickupRoadDistanceMeters: 29000,
        });
        expect(res).not.toBeNull();
        expect(res?.category).toBe(RideMatchCategory.BACKWARD_PICKUP_MATCH);
        expect(res?.pickupFlexibilityDistanceKm).toBe(29.0);
        expect(res?.roadDistanceVerified).toBe(true);
      });

      it('Straight-line distance 25 km, road distance 32 km: reject (> 30 km)', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: p25km,
          dropoff: routeEnd,
          verifiedBackwardPickupRoadDistanceMeters: 32000,
        });
        expect(res).toBeNull();
      });

      it('No road route available (null): reject flexible match', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: p10km,
          dropoff: routeEnd,
          verifiedBackwardPickupRoadDistanceMeters: null,
        });
        expect(res).toBeNull();
      });
    });

    describe('Destination extension road distance validation (50 km limit)', () => {
      // Beyond routeEnd (north along route continuation)
      const d15km = { latitude: 30.3165 + 15 / 111.32, longitude: 78.0322 };
      const d30km = { latitude: 30.3165 + 30 / 111.32, longitude: 78.0322 };
      const d35km = { latitude: 30.3165 + 35 / 111.32, longitude: 78.0322 };
      const d40km = { latitude: 30.3165 + 40 / 111.32, longitude: 78.0322 };
      const d45km = { latitude: 30.3165 + 45 / 111.32, longitude: 78.0322 };

      it('Straight-line distance 15 km, road distance 20 km: accept', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: routeStart,
          dropoff: d15km,
          verifiedDestinationExtensionRoadDistanceMeters: 20000,
        });
        expect(res).not.toBeNull();
        expect(res?.category).toBe(
          RideMatchCategory.EXTENDED_DESTINATION_MATCH,
        );
        expect(res?.destinationExtensionDistanceKm).toBe(20.0);
        expect(res?.roadDistanceVerified).toBe(true);
      });

      it('Straight-line distance 30 km, road distance 45 km: accept', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: routeStart,
          dropoff: d30km,
          verifiedDestinationExtensionRoadDistanceMeters: 45000,
        });
        expect(res).not.toBeNull();
        expect(res?.category).toBe(
          RideMatchCategory.EXTENDED_DESTINATION_MATCH,
        );
        expect(res?.destinationExtensionDistanceKm).toBe(45.0);
        expect(res?.roadDistanceVerified).toBe(true);
      });

      it('Straight-line distance 35 km, road distance 49 km: accept if directional conditions pass', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: routeStart,
          dropoff: d35km,
          verifiedDestinationExtensionRoadDistanceMeters: 49000,
        });
        expect(res).not.toBeNull();
        expect(res?.category).toBe(
          RideMatchCategory.EXTENDED_DESTINATION_MATCH,
        );
        expect(res?.destinationExtensionDistanceKm).toBe(49.0);
        expect(res?.roadDistanceVerified).toBe(true);
      });

      it('Straight-line distance 40 km, road distance 55 km: reject (> 50 km)', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: routeStart,
          dropoff: d40km,
          verifiedDestinationExtensionRoadDistanceMeters: 55000,
        });
        expect(res).toBeNull();
      });

      it('Straight-line distance 45 km, road distance 60 km: reject (> 50 km)', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: routeStart,
          dropoff: d45km,
          verifiedDestinationExtensionRoadDistanceMeters: 60000,
        });
        expect(res).toBeNull();
      });

      it('No road route available (null): reject flexible match', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: routeStart,
          dropoff: d15km,
          verifiedDestinationExtensionRoadDistanceMeters: null,
        });
        expect(res).toBeNull();
      });
    });

    describe('Combined flexible matching road distance validation', () => {
      const p25km = { latitude: 28.5355 - 20 / 111.32, longitude: 77.391 }; // Straight-line ~20km, road testable
      const d30km = { latitude: 30.3165 + 30 / 111.32, longitude: 78.0322 }; // Straight-line ~30km, road testable

      it('Pickup road distance 25 km and destination road distance 40 km: accept', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: p25km,
          dropoff: d30km,
          verifiedBackwardPickupRoadDistanceMeters: 25000,
          verifiedDestinationExtensionRoadDistanceMeters: 40000,
        });
        expect(res).not.toBeNull();
        expect(res?.category).toBe(
          RideMatchCategory.FLEXIBLE_PICKUP_AND_DESTINATION_MATCH,
        );
        expect(res?.pickupFlexibilityDistanceKm).toBe(25.0);
        expect(res?.destinationExtensionDistanceKm).toBe(40.0);
        expect(res?.roadDistanceVerified).toBe(true);
      });

      it('Pickup road distance 35 km and destination road distance 40 km: reject (pickup > 30 km)', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: p25km,
          dropoff: d30km,
          verifiedBackwardPickupRoadDistanceMeters: 35000,
          verifiedDestinationExtensionRoadDistanceMeters: 40000,
        });
        expect(res).toBeNull();
      });

      it('Pickup road distance 25 km and destination road distance 55 km: reject (destination > 50 km)', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: p25km,
          dropoff: d30km,
          verifiedBackwardPickupRoadDistanceMeters: 25000,
          verifiedDestinationExtensionRoadDistanceMeters: 55000,
        });
        expect(res).toBeNull();
      });

      it('Both exactly at their configured limits (30 km & 50 km): accept', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: p25km,
          dropoff: d30km,
          verifiedBackwardPickupRoadDistanceMeters: 30000,
          verifiedDestinationExtensionRoadDistanceMeters: 50000,
        });
        expect(res).not.toBeNull();
        expect(res?.category).toBe(
          RideMatchCategory.FLEXIBLE_PICKUP_AND_DESTINATION_MATCH,
        );
        expect(res?.pickupFlexibilityDistanceKm).toBe(30.0);
        expect(res?.destinationExtensionDistanceKm).toBe(50.0);
        expect(res?.roadDistanceVerified).toBe(true);
      });

      it('Either distance above its limit (e.g. pickup 30.1 km): reject', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: p25km,
          dropoff: d30km,
          verifiedBackwardPickupRoadDistanceMeters: 30100,
          verifiedDestinationExtensionRoadDistanceMeters: 50000,
        });
        expect(res).toBeNull();
      });

      it('Either distance above its limit (e.g. destination 50.1 km): reject', () => {
        const res = evaluateFlexibleDriverRouteMatch({
          routePoints: straightRoute,
          pickup: p25km,
          dropoff: d30km,
          verifiedBackwardPickupRoadDistanceMeters: 30000,
          verifiedDestinationExtensionRoadDistanceMeters: 50100,
        });
        expect(res).toBeNull();
      });
    });
  });
});
