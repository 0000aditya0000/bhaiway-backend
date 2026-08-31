import {
  type LatLng,
  haversineMeters,
  isValidLatLng,
  matchesRouteCorridor,
  projectPointOntoRoute,
} from './route/route-geometry';

/**
 * GPS noise tolerance for exact endpoint match override (meters).
 * Rider pickup/drop within this distance of the driver's published endpoints → 100%.
 */
export const COMMUTE_ROUTE_MATCH_EXACT_ENDPOINT_TOLERANCE_METERS = 75;

/**
 * Distance at which endpoint-to-route proximity reaches 0 for pickup/drop match terms.
 * Independent of the 50 km corridor gate.
 */
export const COMMUTE_ROUTE_MATCH_CLOSENESS_REFERENCE_METERS = 15_000;

export const COMMUTE_ROUTE_MATCH_WEIGHT_PICKUP = 0.3;
export const COMMUTE_ROUTE_MATCH_WEIGHT_DROP = 0.3;
export const COMMUTE_ROUTE_MATCH_WEIGHT_ALIGNMENT = 0.4;

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

function resolveDriverEndpoint(
  explicit: LatLng | null | undefined,
  routeFallback: LatLng,
): LatLng {
  if (explicit && isValidLatLng(explicit)) {
    return explicit;
  }
  return routeFallback;
}

function isExactEndpointMatch(
  pickup: LatLng,
  dropoff: LatLng,
  driverPickup: LatLng,
  driverDropoff: LatLng,
): boolean {
  return (
    haversineMeters(pickup, driverPickup) <=
      COMMUTE_ROUTE_MATCH_EXACT_ENDPOINT_TOLERANCE_METERS &&
    haversineMeters(dropoff, driverDropoff) <=
      COMMUTE_ROUTE_MATCH_EXACT_ENDPOINT_TOLERANCE_METERS
  );
}

function pointAtRoutePosition(
  routePoints: LatLng[],
  targetMeters: number,
): LatLng {
  if (targetMeters <= 0) {
    return routePoints[0];
  }

  let traversed = 0;
  for (let i = 0; i < routePoints.length - 1; i += 1) {
    const a = routePoints[i];
    const b = routePoints[i + 1];
    const segmentLength = haversineMeters(a, b);
    if (traversed + segmentLength >= targetMeters) {
      const t = (targetMeters - traversed) / segmentLength;
      return {
        latitude: a.latitude + (b.latitude - a.latitude) * t,
        longitude: a.longitude + (b.longitude - a.longitude) * t,
      };
    }
    traversed += segmentLength;
  }

  return routePoints[routePoints.length - 1];
}

/**
 * Samples the driver's along-route segment between rider projections and measures
 * how closely it follows the rider's pickup→drop chord.
 */
function computeRouteAlignment(
  routePoints: LatLng[],
  pickup: LatLng,
  dropoff: LatLng,
  pickupProjection: ReturnType<typeof projectPointOntoRoute>,
  dropoffProjection: ReturnType<typeof projectPointOntoRoute>,
): number {
  const segmentStartMeters = pickupProjection.routePositionMeters;
  const segmentEndMeters = dropoffProjection.routePositionMeters;
  if (segmentEndMeters <= segmentStartMeters) {
    return 0;
  }

  const riderChord: LatLng[] = [pickup, dropoff];
  const sampleCount = 8;
  let alignmentSum = 0;
  for (let i = 0; i <= sampleCount; i += 1) {
    const t = i / sampleCount;
    const alongRouteMeters =
      segmentStartMeters + t * (segmentEndMeters - segmentStartMeters);
    const driverSample = pointAtRoutePosition(routePoints, alongRouteMeters);
    const chordProjection = projectPointOntoRoute(driverSample, riderChord);
    alignmentSum += closenessFactor(chordProjection.distanceFromRouteMeters);
  }

  return alignmentSum / (sampleCount + 1);
}

/**
 * Commute route match percentage (0–100 integer).
 *
 * Answers: "How closely does the driver's route match the rider's pickup → drop?"
 *
 * 1. Exact/near-exact endpoint override → 100 when rider pickup/drop are within
 *    {@link COMMUTE_ROUTE_MATCH_EXACT_ENDPOINT_TOLERANCE_METERS} of driver endpoints.
 * 2. Otherwise weighted score:
 *    - pickupMatch (30%): proximity of rider pickup to driver's polyline
 *    - dropMatch (30%): proximity of rider drop to driver's polyline
 *    - routeAlignment (40%): samples the driver's along-route segment between the
 *      rider's projected endpoints and measures proximity to the rider chord.
 */
export function computeCommuteRouteMatchPercentage(params: {
  routePoints: LatLng[];
  pickup: LatLng;
  dropoff: LatLng;
  /** Driver-published pickup; falls back to polyline start. */
  driverPickup?: LatLng | null;
  /** Driver-published drop; falls back to polyline end. */
  driverDropoff?: LatLng | null;
}): number | null {
  const { routePoints, pickup, dropoff, driverPickup, driverDropoff } = params;

  if (routePoints.length < 2) {
    return null;
  }
  if (!isValidLatLng(pickup) || !isValidLatLng(dropoff)) {
    return null;
  }
  if (!matchesRouteCorridor({ routePoints, pickup, dropoff })) {
    return null;
  }

  const driverStart = resolveDriverEndpoint(driverPickup, routePoints[0]);
  const driverEnd = resolveDriverEndpoint(
    driverDropoff,
    routePoints[routePoints.length - 1],
  );

  if (isExactEndpointMatch(pickup, dropoff, driverStart, driverEnd)) {
    return 100;
  }

  const pickupProjection = projectPointOntoRoute(pickup, routePoints);
  const dropoffProjection = projectPointOntoRoute(dropoff, routePoints);

  const driverSegmentMeters =
    dropoffProjection.routePositionMeters -
    pickupProjection.routePositionMeters;
  if (driverSegmentMeters <= 0) {
    return 0;
  }

  const pickupMatch = closenessFactor(pickupProjection.distanceFromRouteMeters);
  const dropMatch = closenessFactor(dropoffProjection.distanceFromRouteMeters);

  const routeAlignment = computeRouteAlignment(
    routePoints,
    pickup,
    dropoff,
    pickupProjection,
    dropoffProjection,
  );

  const raw =
    (COMMUTE_ROUTE_MATCH_WEIGHT_PICKUP * pickupMatch +
      COMMUTE_ROUTE_MATCH_WEIGHT_DROP * dropMatch +
      COMMUTE_ROUTE_MATCH_WEIGHT_ALIGNMENT * routeAlignment) *
    100;

  return clampRoundPercentage(raw);
}
