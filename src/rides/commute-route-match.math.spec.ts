import {
  buildStraightRouteGeometry,
  ROUTE_CORRIDOR_MAX_METERS,
} from './route/route-geometry';
import { computeCommuteRouteMatchPercentage } from './commute-route-match.math';

const NOIDA = { latitude: 28.5355, longitude: 77.391 };
const INDIRAPURAM = { latitude: 28.6415, longitude: 77.372 };
const MEERUT = { latitude: 28.9845, longitude: 77.7064 };
const DEHRADUN = { latitude: 30.3165, longitude: 78.0322 };
const MUMBAI = { latitude: 19.076, longitude: 72.8777 };

describe('commute-route-match.math', () => {
  const published = buildStraightRouteGeometry(NOIDA, DEHRADUN);

  it('exact same endpoints scores close to 100', () => {
    const score = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: NOIDA,
      dropoff: DEHRADUN,
    });
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(95);
    expect(score!).toBeLessThanOrEqual(100);
  });

  it('pickup/dropoff on driver route scores high', () => {
    const score = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: INDIRAPURAM,
      dropoff: DEHRADUN,
    });
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(70);
    expect(score!).toBeLessThanOrEqual(100);
  });

  it('partial segment overlap scores lower than full route', () => {
    const full = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: NOIDA,
      dropoff: DEHRADUN,
    });
    const partial = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: INDIRAPURAM,
      dropoff: MEERUT,
    });
    expect(full).not.toBeNull();
    expect(partial).not.toBeNull();
    expect(partial!).toBeLessThan(full!);
    expect(partial!).toBeGreaterThan(0);
  });

  it('reverse direction returns null (corridor fails)', () => {
    expect(
      computeCommuteRouteMatchPercentage({
        routePoints: published.points,
        pickup: DEHRADUN,
        dropoff: MEERUT,
      }),
    ).toBeNull();
  });

  it('pickup far from route returns null', () => {
    expect(
      computeCommuteRouteMatchPercentage({
        routePoints: published.points,
        pickup: MUMBAI,
        dropoff: DEHRADUN,
      }),
    ).toBeNull();
  });

  it('clamps to 0–100 and never returns NaN', () => {
    const score = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: NOIDA,
      dropoff: MEERUT,
    });
    expect(score).not.toBeNull();
    expect(Number.isFinite(score)).toBe(true);
    expect(score!).toBeGreaterThanOrEqual(0);
    expect(score!).toBeLessThanOrEqual(100);
  });

  it('near-corridor-limit deviation scores lower than on-route trip', () => {
    const onRoute = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: MEERUT,
      dropoff: DEHRADUN,
    });

    const farPickup = {
      latitude: MEERUT.latitude + 0.35,
      longitude: MEERUT.longitude + 0.35,
    };
    const farScore = computeCommuteRouteMatchPercentage({
      routePoints: published.points,
      pickup: farPickup,
      dropoff: DEHRADUN,
    });

    expect(onRoute).not.toBeNull();
    if (farScore !== null) {
      expect(farScore).toBeLessThan(onRoute!);
    }
    expect(farPickup).toBeDefined();
    expect(ROUTE_CORRIDOR_MAX_METERS).toBeGreaterThan(0);
  });
});
