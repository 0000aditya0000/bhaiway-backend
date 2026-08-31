import {
  buildStraightRouteGeometry,
  haversineMeters,
  ROUTE_CORRIDOR_MAX_METERS,
  type LatLng,
} from './route/route-geometry';
import {
  COMMUTE_ROUTE_MATCH_EXACT_ENDPOINT_TOLERANCE_METERS,
  computeCommuteRouteMatchPercentage,
} from './commute-route-match.math';

const NOIDA = { latitude: 28.5355, longitude: 77.391 };
const INDIRAPURAM = { latitude: 28.6415, longitude: 77.372 };
const MEERUT = { latitude: 28.9845, longitude: 77.7064 };
const DEHRADUN = { latitude: 30.3165, longitude: 78.0322 };
const MUMBAI = { latitude: 19.076, longitude: 72.8777 };

/** ~40 m north-east of Noida — within GPS tolerance. */
const NOIDA_GPS_JITTER = {
  latitude: NOIDA.latitude + 0.00035,
  longitude: NOIDA.longitude + 0.00035,
};

function pointAlongRoute(routePoints: LatLng[], fraction: number): LatLng {
  let total = 0;
  for (let i = 1; i < routePoints.length; i += 1) {
    total += haversineMeters(routePoints[i - 1], routePoints[i]);
  }
  const target = total * fraction;
  let traversed = 0;
  for (let i = 1; i < routePoints.length; i += 1) {
    const a = routePoints[i - 1];
    const b = routePoints[i];
    const segment = haversineMeters(a, b);
    if (traversed + segment >= target) {
      const t = (target - traversed) / segment;
      return {
        latitude: a.latitude + (b.latitude - a.latitude) * t,
        longitude: a.longitude + (b.longitude - a.longitude) * t,
      };
    }
    traversed += segment;
  }
  return routePoints[routePoints.length - 1];
}

describe('commute-route-match.math', () => {
  const published = buildStraightRouteGeometry(NOIDA, DEHRADUN);
  const onRouteMid = pointAlongRoute(published.points, 0.55);
  const onRoutePartialPickup = pointAlongRoute(published.points, 0.2);
  const onRoutePartialDrop = pointAlongRoute(published.points, 0.65);

  it('exact same pickup and drop returns 100%', () => {
    expect(
      computeCommuteRouteMatchPercentage({
        routePoints: published.points,
        pickup: NOIDA,
        dropoff: DEHRADUN,
        driverPickup: NOIDA,
        driverDropoff: DEHRADUN,
      }),
    ).toBe(100);
  });

  it('tiny GPS coordinate differences within tolerance return 100%', () => {
    expect(
      computeCommuteRouteMatchPercentage({
        routePoints: published.points,
        pickup: NOIDA_GPS_JITTER,
        dropoff: DEHRADUN,
        driverPickup: NOIDA,
        driverDropoff: DEHRADUN,
      }),
    ).toBe(100);
    expect(
      haversineMeters(NOIDA_GPS_JITTER, NOIDA),
    ).toBeLessThanOrEqual(COMMUTE_ROUTE_MATCH_EXACT_ENDPOINT_TOLERANCE_METERS);
  });

  it('shorter segment along driver route scores high (not penalized by total route length)', () => {
    const full = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: NOIDA,
      dropoff: DEHRADUN,
      driverPickup: NOIDA,
      driverDropoff: DEHRADUN,
    });
    const partialToEnd = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: onRoutePartialPickup,
      dropoff: DEHRADUN,
      driverPickup: NOIDA,
      driverDropoff: DEHRADUN,
    });
    const partialMiddle = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: onRoutePartialPickup,
      dropoff: onRoutePartialDrop,
      driverPickup: NOIDA,
      driverDropoff: DEHRADUN,
    });

    expect(full).toBe(100);
    expect(partialToEnd).not.toBeNull();
    expect(partialMiddle).not.toBeNull();
    expect(partialToEnd!).toBeGreaterThanOrEqual(95);
    expect(partialMiddle!).toBeGreaterThanOrEqual(95);
  });

  it('pickup/drop on driver route scores very high', () => {
    const score = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: onRouteMid,
      dropoff: DEHRADUN,
      driverPickup: NOIDA,
      driverDropoff: DEHRADUN,
    });
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(90);
  });

  it('slight pickup/drop deviation scores high but below exact match', () => {
    const exact = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: NOIDA,
      dropoff: DEHRADUN,
      driverPickup: NOIDA,
      driverDropoff: DEHRADUN,
    });
    const slightOffsetPickup = {
      latitude: NOIDA.latitude + 0.03,
      longitude: NOIDA.longitude,
    };
    const offset = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: slightOffsetPickup,
      dropoff: DEHRADUN,
      driverPickup: NOIDA,
      driverDropoff: DEHRADUN,
    });

    expect(exact).toBe(100);
    expect(offset).not.toBeNull();
    expect(offset!).toBeGreaterThanOrEqual(85);
    expect(offset!).toBeLessThan(100);
  });

  it('significant deviation within corridor scores lower than on-route trip', () => {
    const onRoute = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: onRouteMid,
      dropoff: DEHRADUN,
      driverPickup: NOIDA,
      driverDropoff: DEHRADUN,
    });

    const farPickup = {
      latitude: MEERUT.latitude + 0.12,
      longitude: MEERUT.longitude + 0.12,
    };
    const deviated = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: farPickup,
      dropoff: DEHRADUN,
      driverPickup: NOIDA,
      driverDropoff: DEHRADUN,
    });

    expect(onRoute).not.toBeNull();
    expect(deviated).not.toBeNull();
    expect(deviated!).toBeLessThan(onRoute!);
    expect(deviated!).toBeGreaterThan(0);
  });

  it('reverse direction returns null (corridor fails)', () => {
    expect(
      computeCommuteRouteMatchPercentage({
        routePoints: published.points,
        pickup: DEHRADUN,
        dropoff: MEERUT,
        driverPickup: NOIDA,
        driverDropoff: DEHRADUN,
      }),
    ).toBeNull();
  });

  it('pickup far from route returns null', () => {
    expect(
      computeCommuteRouteMatchPercentage({
        routePoints: published.points,
        pickup: MUMBAI,
        dropoff: DEHRADUN,
        driverPickup: NOIDA,
        driverDropoff: DEHRADUN,
      }),
    ).toBeNull();
  });

  it('clamps to 0–100 and never returns NaN', () => {
    const score = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: NOIDA,
      dropoff: MEERUT,
      driverPickup: NOIDA,
      driverDropoff: DEHRADUN,
    });
    expect(score).not.toBeNull();
    expect(Number.isFinite(score)).toBe(true);
    expect(score!).toBeGreaterThanOrEqual(0);
    expect(score!).toBeLessThanOrEqual(100);
    expect(ROUTE_CORRIDOR_MAX_METERS).toBeGreaterThan(0);
  });
});
