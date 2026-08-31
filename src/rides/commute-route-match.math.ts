import {
  type LatLng,
  haversineMeters,
  isValidLatLng,
  matchesRouteCorridor,
  projectPointOntoRoute,
} from './route/route-geometry';

/**
 * Distance at which endpoint closeness reaches 0 for match scoring.
 * Independent of the 50 km corridor gate — only shapes the 0–100 score.
 */
export const COMMUTE_ROUTE_MATCH_CLOSENESS_REFERENCE_METERS = 15_000;

function routeLengthMeters(routePoints: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < routePoints.length; i += 1) {
    total += haversineMeters(routePoints[i - 1], routePoints[i]);
  }
  return total;
}

function closenessFactor(distanceFromRouteMeters: number): number {
  return Math.max(
    0,
    1 -
      distanceFromRouteMeters / COMMUTE_ROUTE_MATCH_CLOSENESS_REFERENCE_METERS,
  );
}

function clampRoundPercentage(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(Math.max(0, Math.min(100, value)));
}

/**
 * Commute route match percentage (0–100 integer).
 *
 * Uses the driver's published polyline:
 * 1. Project rider pickup/dropoff onto the route (same geometry as corridor match).
 * 2. driverSegmentMeters = along-route distance between projections.
 * 3. riderTripMeters = geodesic pickup→dropoff distance.
 * 4. pathEfficiency = min/max segment vs direct trip lengths.
 * 5. endpointCloseness = average closeness from perpendicular deviation.
 * 6. coverage = driverSegment / total route length (partial trips score lower).
 *
 * score = pathEfficiency × endpointCloseness × coverage × 100
 */
export function computeCommuteRouteMatchPercentage(params: {
  routePoints: LatLng[];
  pickup: LatLng;
  dropoff: LatLng;
}): number | null {
  const { routePoints, pickup, dropoff } = params;

  if (routePoints.length < 2) {
    return null;
  }
  if (!isValidLatLng(pickup) || !isValidLatLng(dropoff)) {
    return null;
  }
  if (!matchesRouteCorridor({ routePoints, pickup, dropoff })) {
    return null;
  }

  const pickupProjection = projectPointOntoRoute(pickup, routePoints);
  const dropoffProjection = projectPointOntoRoute(dropoff, routePoints);

  const driverSegmentMeters =
    dropoffProjection.routePositionMeters -
    pickupProjection.routePositionMeters;
  if (driverSegmentMeters <= 0) {
    return 0;
  }

  const riderTripMeters = haversineMeters(pickup, dropoff);
  const totalRouteMeters = routeLengthMeters(routePoints);
  if (totalRouteMeters <= 0) {
    return null;
  }

  const pathEfficiency =
    Math.min(riderTripMeters, driverSegmentMeters) /
    Math.max(riderTripMeters, driverSegmentMeters);

  const endpointCloseness =
    (closenessFactor(pickupProjection.distanceFromRouteMeters) +
      closenessFactor(dropoffProjection.distanceFromRouteMeters)) /
    2;

  const coverage = Math.min(1, driverSegmentMeters / totalRouteMeters);

  return clampRoundPercentage(
    pathEfficiency * endpointCloseness * coverage * 100,
  );
}
