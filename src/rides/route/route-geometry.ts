/**
 * Route corridor helpers for ride search.
 * Pure geometry — no Nest/DB dependencies.
 */

export const ROUTE_CORRIDOR_MAX_METERS = 50_000;
/** Minimum along-route separation between pickup and dropoff projections. */
export const ROUTE_MIN_PROGRESS_METERS = 50;
/** Densify geodesic segments about every N meters for projection accuracy. */
export const ROUTE_DENSIFY_STEP_METERS = 2_000;

/**
 * Passenger search against a driver-selected route (A → B).
 * Assured geographic queue keeps {@link ROUTE_CORRIDOR_MAX_METERS}.
 */
export const SOURCE_CATCHMENT_METERS = 50_000;
export const SELECTED_ROUTE_CORRIDOR_METERS = 20_000;
/** Pickup→dropoff along-route minimum for selected-route passenger search. */
export const SELECTED_ROUTE_MIN_PROGRESS_METERS = 100;
/** GPS / geometry slack at A and B. */
export const ROUTE_ENDPOINT_TOLERANCE_METERS = 250;
const MAX_PROJECTION_CANDIDATES = 12;
const PROJECTION_DEDUPE_METERS = 75;

/** Configurable geographic flexibility allowances. */
export const DEFAULT_BACKWARD_PICKUP_ALLOWANCE_KM = 30;
export const DEFAULT_DESTINATION_EXTENSION_ALLOWANCE_KM = 50;
export const BACKWARD_PICKUP_ALLOWANCE_METERS =
  DEFAULT_BACKWARD_PICKUP_ALLOWANCE_KM * 1_000;
export const DESTINATION_EXTENSION_ALLOWANCE_METERS =
  DEFAULT_DESTINATION_EXTENSION_ALLOWANCE_KM * 1_000;

export enum RideMatchCategory {
  FORWARD_ROUTE_MATCH = 'FORWARD_ROUTE_MATCH',
  BACKWARD_PICKUP_MATCH = 'BACKWARD_PICKUP_MATCH',
  EXTENDED_DESTINATION_MATCH = 'EXTENDED_DESTINATION_MATCH',
  FLEXIBLE_PICKUP_AND_DESTINATION_MATCH = 'FLEXIBLE_PICKUP_AND_DESTINATION_MATCH',
}

export interface RouteMatchResult {
  category: RideMatchCategory;
  isFlexible: boolean;
  pickupFlexibilityDistanceKm: number | null;
  destinationExtensionDistanceKm: number | null;
  pickupFlexibilityDistanceMeters: number;
  destinationExtensionDistanceMeters: number;
  actualDriverPickupLocation: LatLng;
  actualDriverDropLocation: LatLng;
  requiresIndependentPickupTravel: boolean;
  requiresIndependentDestinationTravel: boolean;
  score: number;
}

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface RouteProjection {
  point: LatLng;
  /** Distance from route start along the polyline (meters). */
  routePositionMeters: number;
  /** Perpendicular distance from the query point to the route (meters). */
  distanceFromRouteMeters: number;
}

export interface RouteBoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface BuiltRouteGeometry {
  polylineEncoded: string;
  points: LatLng[];
  lengthMeters: number;
  bbox: RouteBoundingBox;
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const earthRadiusM = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isValidLatLng(point: LatLng): boolean {
  return (
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    point.latitude >= -90 &&
    point.latitude <= 90 &&
    point.longitude >= -180 &&
    point.longitude <= 180 &&
    !(point.latitude === 0 && point.longitude === 0)
  );
}

/** Google-encoded polyline (precision 5). */
export function encodePolyline(points: LatLng[]): string {
  let lastLat = 0;
  let lastLng = 0;
  let result = '';

  for (const point of points) {
    const lat = Math.round(point.latitude * 1e5);
    const lng = Math.round(point.longitude * 1e5);
    result += encodeSigned(lat - lastLat);
    result += encodeSigned(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return result;
}

export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    const latChange = decodeSigned(encoded);
    const lngChange = decodeSigned(encoded);
    lat += latChange;
    lng += lngChange;
    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }

  function decodeSigned(value: string): number {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = value.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  }

  return points;
}

function encodeSigned(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

export function densifySegment(
  a: LatLng,
  b: LatLng,
  stepMeters = ROUTE_DENSIFY_STEP_METERS,
): LatLng[] {
  const distance = haversineMeters(a, b);
  if (distance <= stepMeters) {
    return [a, b];
  }
  const steps = Math.ceil(distance / stepMeters);
  const points: LatLng[] = [a];
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    points.push({
      latitude: a.latitude + (b.latitude - a.latitude) * t,
      longitude: a.longitude + (b.longitude - a.longitude) * t,
    });
  }
  points.push(b);
  return points;
}

/** Build densified geodesic polyline between endpoints (no external API). */
export function buildStraightRouteGeometry(
  source: LatLng,
  destination: LatLng,
): BuiltRouteGeometry {
  const points = densifySegment(source, destination);
  return finalizeRouteGeometry(points);
}

export function finalizeRouteGeometry(points: LatLng[]): BuiltRouteGeometry {
  if (points.length < 2) {
    throw new Error('Route requires at least two points');
  }
  let lengthMeters = 0;
  for (let i = 1; i < points.length; i += 1) {
    lengthMeters += haversineMeters(points[i - 1], points[i]);
  }
  return {
    polylineEncoded: encodePolyline(points),
    points,
    lengthMeters,
    bbox: boundingBoxOf(points),
  };
}

export function boundingBoxOf(points: LatLng[]): RouteBoundingBox {
  let minLat = points[0].latitude;
  let maxLat = points[0].latitude;
  let minLng = points[0].longitude;
  let maxLng = points[0].longitude;
  for (const point of points) {
    minLat = Math.min(minLat, point.latitude);
    maxLat = Math.max(maxLat, point.latitude);
    minLng = Math.min(minLng, point.longitude);
    maxLng = Math.max(maxLng, point.longitude);
  }
  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Expand bbox by approximately `meters` in each direction.
 * 1° latitude ≈ 111_320 m; longitude scales with cos(lat).
 */
export function expandBoundingBox(
  bbox: RouteBoundingBox,
  meters: number,
): RouteBoundingBox {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const latPad = meters / 111_320;
  const cos = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const lngPad = meters / (111_320 * cos);
  return {
    minLat: bbox.minLat - latPad,
    maxLat: bbox.maxLat + latPad,
    minLng: bbox.minLng - lngPad,
    maxLng: bbox.maxLng + lngPad,
  };
}

export function projectPointOntoRoute(
  point: LatLng,
  route: LatLng[],
): RouteProjection {
  if (route.length === 0) {
    throw new Error('Empty route');
  }
  if (route.length === 1) {
    return {
      point: route[0],
      routePositionMeters: 0,
      distanceFromRouteMeters: haversineMeters(point, route[0]),
    };
  }

  let bestDistance = Number.POSITIVE_INFINITY;
  let bestPoint = route[0];
  let bestAlong = 0;
  let traversed = 0;

  for (let i = 0; i < route.length - 1; i += 1) {
    const a = route[i];
    const b = route[i + 1];
    const segmentLength = haversineMeters(a, b);
    const projected = projectOntoSegment(point, a, b);
    const distance = haversineMeters(point, projected.point);
    const along = traversed + projected.t * segmentLength;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPoint = projected.point;
      bestAlong = along;
    }
    traversed += segmentLength;
  }

  return {
    point: bestPoint,
    routePositionMeters: bestAlong,
    distanceFromRouteMeters: bestDistance,
  };
}

function projectOntoSegment(
  point: LatLng,
  a: LatLng,
  b: LatLng,
): { point: LatLng; t: number; tUnclamped: number } {
  const ax = a.longitude;
  const ay = a.latitude;
  const bx = b.longitude;
  const by = b.latitude;
  const px = point.longitude;
  const py = point.latitude;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return { point: a, t: 0, tUnclamped: 0 };
  }
  const tUnclamped = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  const t = Math.max(0, Math.min(1, tUnclamped));
  return {
    point: {
      latitude: ay + t * dy,
      longitude: ax + t * dx,
    },
    t,
    tUnclamped,
  };
}

export function matchesRouteCorridor(params: {
  routePoints: LatLng[];
  pickup: LatLng;
  dropoff: LatLng;
  corridorMaxMeters?: number;
  minProgressMeters?: number;
}): boolean {
  const corridorMax = params.corridorMaxMeters ?? ROUTE_CORRIDOR_MAX_METERS;
  const minProgress = params.minProgressMeters ?? ROUTE_MIN_PROGRESS_METERS;

  if (
    !isValidLatLng(params.pickup) ||
    !isValidLatLng(params.dropoff) ||
    params.routePoints.length < 2
  ) {
    return false;
  }

  const pickupProjection = projectPointOntoRoute(
    params.pickup,
    params.routePoints,
  );
  const dropoffProjection = projectPointOntoRoute(
    params.dropoff,
    params.routePoints,
  );

  if (pickupProjection.distanceFromRouteMeters > corridorMax) {
    return false;
  }
  if (dropoffProjection.distanceFromRouteMeters > corridorMax) {
    return false;
  }
  if (
    dropoffProjection.routePositionMeters <
    pickupProjection.routePositionMeters + minProgress
  ) {
    return false;
  }
  return true;
}

export function pointInExpandedRouteBBox(
  point: LatLng,
  bbox: RouteBoundingBox,
  corridorMaxMeters = ROUTE_CORRIDOR_MAX_METERS,
): boolean {
  const expanded = expandBoundingBox(bbox, corridorMaxMeters);
  return (
    point.latitude >= expanded.minLat &&
    point.latitude <= expanded.maxLat &&
    point.longitude >= expanded.minLng &&
    point.longitude <= expanded.maxLng
  );
}

function firstForwardAnchor(route: LatLng[]): { a: LatLng; b: LatLng } | null {
  if (route.length < 2) {
    return null;
  }
  const a = route[0];
  for (let i = 1; i < route.length; i += 1) {
    if (haversineMeters(a, route[i]) >= 10) {
      return { a, b: route[i] };
    }
  }
  return { a, b: route[1] };
}

/**
 * True when `point` lies behind source A along the first forward segment,
 * farther than {@link ROUTE_ENDPOINT_TOLERANCE_METERS}.
 */
export function isPointBehindRouteSource(
  point: LatLng,
  route: LatLng[],
): boolean {
  const anchor = firstForwardAnchor(route);
  if (!anchor) {
    return true;
  }
  const { a, b } = anchor;
  const dx = b.longitude - a.longitude;
  const dy = b.latitude - a.latitude;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return false;
  }
  const t =
    ((point.longitude - a.longitude) * dx +
      (point.latitude - a.latitude) * dy) /
    lengthSq;
  if (t >= 0) {
    return false;
  }
  return haversineMeters(point, a) > ROUTE_ENDPOINT_TOLERANCE_METERS;
}

export function collectProjectionCandidates(
  point: LatLng,
  route: LatLng[],
  maxDistanceMeters: number,
  maxCandidates = MAX_PROJECTION_CANDIDATES,
): RouteProjection[] {
  if (route.length < 2 || !isValidLatLng(point)) {
    return [];
  }

  const raw: RouteProjection[] = [];
  let traversed = 0;
  for (let i = 0; i < route.length - 1; i += 1) {
    const a = route[i];
    const b = route[i + 1];
    const segmentLength = haversineMeters(a, b);
    const projected = projectOntoSegment(point, a, b);
    if (projected.tUnclamped < -0.01 || projected.tUnclamped > 1.01) {
      traversed += segmentLength;
      continue;
    }
    const distance = haversineMeters(point, projected.point);
    if (distance <= maxDistanceMeters) {
      raw.push({
        point: projected.point,
        routePositionMeters: traversed + projected.t * segmentLength,
        distanceFromRouteMeters: distance,
      });
    }
    traversed += segmentLength;
  }

  raw.sort(
    (left, right) =>
      left.distanceFromRouteMeters - right.distanceFromRouteMeters ||
      left.routePositionMeters - right.routePositionMeters,
  );

  const deduped: RouteProjection[] = [];
  for (const candidate of raw) {
    const duplicate = deduped.some(
      (existing) =>
        Math.abs(existing.routePositionMeters - candidate.routePositionMeters) <
        PROJECTION_DEDUPE_METERS,
    );
    if (!duplicate) {
      deduped.push(candidate);
    }
    if (deduped.length >= maxCandidates) {
      break;
    }
  }
  return deduped;
}

function routeLengthMetersOf(route: LatLng[]): number {
  let length = 0;
  for (let i = 1; i < route.length; i += 1) {
    length += haversineMeters(route[i - 1], route[i]);
  }
  return length;
}

function isPickupInSourceCatchment(params: {
  pickup: LatLng;
  source: LatLng;
  candidate: RouteProjection;
  route: LatLng[];
}): boolean {
  if (haversineMeters(params.pickup, params.source) > SOURCE_CATCHMENT_METERS) {
    return false;
  }
  if (params.candidate.routePositionMeters > SOURCE_CATCHMENT_METERS) {
    return false;
  }
  if (params.candidate.routePositionMeters < -ROUTE_ENDPOINT_TOLERANCE_METERS) {
    return false;
  }
  if (isPointBehindRouteSource(params.pickup, params.route)) {
    return false;
  }
  return true;
}

function isPickupOnSelectedCorridor(params: {
  pickup: LatLng;
  candidate: RouteProjection;
  routeLengthMeters: number;
  route: LatLng[];
}): boolean {
  if (
    params.candidate.distanceFromRouteMeters > SELECTED_ROUTE_CORRIDOR_METERS
  ) {
    return false;
  }
  if (params.candidate.routePositionMeters < -ROUTE_ENDPOINT_TOLERANCE_METERS) {
    return false;
  }
  if (
    params.candidate.routePositionMeters >
    params.routeLengthMeters + ROUTE_ENDPOINT_TOLERANCE_METERS
  ) {
    return false;
  }
  if (isPointBehindRouteSource(params.pickup, params.route)) {
    return false;
  }
  return true;
}

function isDropoffOnSelectedCorridor(params: {
  candidate: RouteProjection;
  routeLengthMeters: number;
}): boolean {
  if (
    params.candidate.distanceFromRouteMeters > SELECTED_ROUTE_CORRIDOR_METERS
  ) {
    return false;
  }
  if (params.candidate.routePositionMeters < -ROUTE_ENDPOINT_TOLERANCE_METERS) {
    return false;
  }
  if (
    params.candidate.routePositionMeters >
    params.routeLengthMeters + ROUTE_ENDPOINT_TOLERANCE_METERS
  ) {
    return false;
  }
  return true;
}

/**
 * Direction-aware passenger match against a driver-selected A → B polyline.
 * Uses multiple projection candidates so loops/self-crossings are not bound
 * to the single nearest segment.
 */
export function findBestSelectedDriverRouteMatch(params: {
  routePoints: LatLng[];
  pickup: LatLng;
  dropoff: LatLng;
  source?: LatLng | null;
  destination?: LatLng | null;
  minProgressMeters?: number;
}): {
  pickup: RouteProjection;
  dropoff: RouteProjection;
  score: number;
} | null {
  const route = params.routePoints;
  if (
    route.length < 2 ||
    !isValidLatLng(params.pickup) ||
    !isValidLatLng(params.dropoff)
  ) {
    return null;
  }

  const source =
    params.source && isValidLatLng(params.source) ? params.source : route[0];
  const routeLength = routeLengthMetersOf(route);
  const minProgress =
    params.minProgressMeters ?? SELECTED_ROUTE_MIN_PROGRESS_METERS;

  const pickupCandidates = collectProjectionCandidates(
    params.pickup,
    route,
    SOURCE_CATCHMENT_METERS,
  );
  const dropoffCandidates = collectProjectionCandidates(
    params.dropoff,
    route,
    SELECTED_ROUTE_CORRIDOR_METERS,
  );
  if (pickupCandidates.length === 0 || dropoffCandidates.length === 0) {
    return null;
  }

  const nearestPickup = pickupCandidates[0];
  const nearestPickupDistance = nearestPickup.distanceFromRouteMeters;
  const closePickupDistanceBudget = Math.max(
    nearestPickupDistance * 1.5,
    nearestPickupDistance + 500,
  );
  const pickupPool =
    nearestPickup.routePositionMeters > SOURCE_CATCHMENT_METERS
      ? pickupCandidates.filter(
          (candidate) =>
            candidate.distanceFromRouteMeters <= closePickupDistanceBudget,
        )
      : pickupCandidates;
  const eligiblePickups = pickupPool.filter((candidate) => {
    const sourceEligible =
      candidate.distanceFromRouteMeters <= closePickupDistanceBudget &&
      isPickupInSourceCatchment({
        pickup: params.pickup,
        source,
        candidate,
        route,
      });
    const corridorEligible = isPickupOnSelectedCorridor({
      pickup: params.pickup,
      candidate,
      routeLengthMeters: routeLength,
      route,
    });
    return sourceEligible || corridorEligible;
  });
  const eligibleDropoffs = dropoffCandidates.filter((candidate) =>
    isDropoffOnSelectedCorridor({
      candidate,
      routeLengthMeters: routeLength,
    }),
  );
  if (eligiblePickups.length === 0 || eligibleDropoffs.length === 0) {
    return null;
  }

  type Pair = {
    pickup: RouteProjection;
    dropoff: RouteProjection;
    score: number;
  };
  const pairs: Pair[] = [];
  for (const pickup of eligiblePickups) {
    for (const dropoff of eligibleDropoffs) {
      if (
        dropoff.routePositionMeters <
        pickup.routePositionMeters + minProgress
      ) {
        continue;
      }
      pairs.push({
        pickup,
        dropoff,
        score: pickup.distanceFromRouteMeters + dropoff.distanceFromRouteMeters,
      });
    }
  }
  if (pairs.length === 0) {
    return null;
  }

  pairs.sort(
    (left, right) =>
      left.score - right.score ||
      left.pickup.routePositionMeters - right.pickup.routePositionMeters ||
      left.dropoff.routePositionMeters - right.dropoff.routePositionMeters,
  );
  return pairs[0];
}

export function matchesSelectedDriverRoute(params: {
  routePoints: LatLng[];
  pickup: LatLng;
  dropoff: LatLng;
  source?: LatLng | null;
  destination?: LatLng | null;
  minProgressMeters?: number;
}): boolean {
  return findBestSelectedDriverRouteMatch(params) !== null;
}

export function lastForwardAnchor(
  route: LatLng[],
): { u: LatLng; v: LatLng } | null {
  if (route.length < 2) {
    return null;
  }
  const v = route[route.length - 1];
  for (let i = route.length - 2; i >= 0; i -= 1) {
    if (haversineMeters(route[i], v) >= 10) {
      return { u: route[i], v };
    }
  }
  return { u: route[route.length - 2], v };
}

function evaluateBackwardPickupCandidate(params: {
  pickup: LatLng;
  dropoff: LatLng;
  source: LatLng;
  route: LatLng[];
  backwardPickupAllowanceMeters: number;
}): { distanceMeters: number; startPoint: LatLng } | null {
  const { pickup, dropoff, source, route, backwardPickupAllowanceMeters } =
    params;
  const distToStart = haversineMeters(pickup, source);
  if (distToStart > backwardPickupAllowanceMeters) {
    return null;
  }

  if (!isPointBehindRouteSource(pickup, route)) {
    return null;
  }

  const anchor = firstForwardAnchor(route);
  if (!anchor) {
    return null;
  }
  const { a, b } = anchor;
  const dx = b.longitude - a.longitude;
  const dy = b.latitude - a.latitude;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return null;
  }

  const tUnclamped =
    ((pickup.longitude - a.longitude) * dx +
      (pickup.latitude - a.latitude) * dy) /
    lengthSq;
  const projLat = a.latitude + tUnclamped * dy;
  const projLng = a.longitude + tUnclamped * dx;
  const perpDist = haversineMeters(pickup, {
    latitude: projLat,
    longitude: projLng,
  });

  if (perpDist > SELECTED_ROUTE_CORRIDOR_METERS) {
    return null;
  }

  if (
    haversineMeters(pickup, dropoff) <
    haversineMeters(source, dropoff) - ROUTE_ENDPOINT_TOLERANCE_METERS
  ) {
    return null;
  }

  return {
    distanceMeters: distToStart,
    startPoint: source,
  };
}

function evaluateExtendedDestinationCandidate(params: {
  pickup: LatLng;
  dropoff: LatLng;
  destination: LatLng;
  route: LatLng[];
  destinationExtensionAllowanceMeters: number;
}): { distanceMeters: number; endPoint: LatLng } | null {
  const {
    pickup,
    dropoff,
    destination,
    route,
    destinationExtensionAllowanceMeters,
  } = params;
  const distToEnd = haversineMeters(dropoff, destination);
  if (distToEnd > destinationExtensionAllowanceMeters) {
    return null;
  }

  if (distToEnd <= ROUTE_ENDPOINT_TOLERANCE_METERS) {
    return null;
  }

  const anchor = lastForwardAnchor(route);
  if (!anchor) {
    return null;
  }
  const { u, v } = anchor;
  const dx = v.longitude - u.longitude;
  const dy = v.latitude - u.latitude;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return null;
  }

  const vox = dropoff.longitude - v.longitude;
  const voy = dropoff.latitude - v.latitude;
  const tUnclamped = (vox * dx + voy * dy) / lengthSq;

  if (tUnclamped < -0.1) {
    return null;
  }

  const arrivalLen = Math.sqrt(lengthSq);
  const onwardLen = Math.sqrt(vox * vox + voy * voy);
  if (onwardLen > 0) {
    const cosAngle = (vox * dx + voy * dy) / (arrivalLen * onwardLen);
    if (cosAngle < -0.25) {
      return null;
    }
  }

  const projLat = v.latitude + tUnclamped * dy;
  const projLng = v.longitude + tUnclamped * dx;
  const perpDist = haversineMeters(dropoff, {
    latitude: projLat,
    longitude: projLng,
  });

  if (perpDist > SELECTED_ROUTE_CORRIDOR_METERS) {
    return null;
  }

  if (
    haversineMeters(pickup, dropoff) <
    haversineMeters(pickup, destination) - ROUTE_ENDPOINT_TOLERANCE_METERS
  ) {
    return null;
  }

  return {
    distanceMeters: distToEnd,
    endPoint: destination,
  };
}

/**
 * Enhanced passenger match supporting backward pickup (up to 30km) and
 * destination extension (up to 50km) with strict category classification.
 */
export function evaluateFlexibleDriverRouteMatch(params: {
  routePoints: LatLng[];
  pickup: LatLng;
  dropoff: LatLng;
  source?: LatLng | null;
  destination?: LatLng | null;
  minProgressMeters?: number;
  backwardPickupAllowanceMeters?: number;
  destinationExtensionAllowanceMeters?: number;
}): RouteMatchResult | null {
  const route = params.routePoints;
  if (
    route.length < 2 ||
    !isValidLatLng(params.pickup) ||
    !isValidLatLng(params.dropoff)
  ) {
    return null;
  }

  const source =
    params.source && isValidLatLng(params.source) ? params.source : route[0];
  const destination =
    params.destination && isValidLatLng(params.destination)
      ? params.destination
      : route[route.length - 1];

  const minProgress =
    params.minProgressMeters ?? SELECTED_ROUTE_MIN_PROGRESS_METERS;
  const backwardPickupLimit =
    params.backwardPickupAllowanceMeters ?? BACKWARD_PICKUP_ALLOWANCE_METERS;
  const destinationExtensionLimit =
    params.destinationExtensionAllowanceMeters ??
    DESTINATION_EXTENSION_ALLOWANCE_METERS;

  // 1. Check FORWARD_ROUTE_MATCH first (preferred)
  const forwardMatch = findBestSelectedDriverRouteMatch({
    routePoints: route,
    pickup: params.pickup,
    dropoff: params.dropoff,
    source,
    destination,
    minProgressMeters: minProgress,
  });

  if (forwardMatch) {
    return {
      category: RideMatchCategory.FORWARD_ROUTE_MATCH,
      isFlexible: false,
      pickupFlexibilityDistanceKm: null,
      destinationExtensionDistanceKm: null,
      pickupFlexibilityDistanceMeters: 0,
      destinationExtensionDistanceMeters: 0,
      actualDriverPickupLocation: source,
      actualDriverDropLocation: destination,
      requiresIndependentPickupTravel: false,
      requiresIndependentDestinationTravel: false,
      score: forwardMatch.score,
    };
  }

  const routeLength = routeLengthMetersOf(route);
  const pickupCandidates = collectProjectionCandidates(
    params.pickup,
    route,
    SOURCE_CATCHMENT_METERS,
  );
  const dropoffCandidates = collectProjectionCandidates(
    params.dropoff,
    route,
    SELECTED_ROUTE_CORRIDOR_METERS,
  );

  const eligibleDropoffs = dropoffCandidates.filter((candidate) =>
    isDropoffOnSelectedCorridor({
      candidate,
      routeLengthMeters: routeLength,
    }),
  );

  const nearestPickup = pickupCandidates[0];
  const nearestPickupDistance = nearestPickup?.distanceFromRouteMeters ?? 0;
  const closePickupDistanceBudget = Math.max(
    nearestPickupDistance * 1.5,
    nearestPickupDistance + 500,
  );
  const pickupPool =
    nearestPickup && nearestPickup.routePositionMeters > SOURCE_CATCHMENT_METERS
      ? pickupCandidates.filter(
          (candidate) =>
            candidate.distanceFromRouteMeters <= closePickupDistanceBudget,
        )
      : pickupCandidates;
  const eligiblePickups = pickupPool.filter((candidate) => {
    const sourceEligible =
      candidate.distanceFromRouteMeters <= closePickupDistanceBudget &&
      isPickupInSourceCatchment({
        pickup: params.pickup,
        source,
        candidate,
        route,
      });
    const corridorEligible = isPickupOnSelectedCorridor({
      pickup: params.pickup,
      candidate,
      routeLengthMeters: routeLength,
      route,
    });
    return sourceEligible || corridorEligible;
  });

  const backwardPickup = evaluateBackwardPickupCandidate({
    pickup: params.pickup,
    dropoff: params.dropoff,
    source,
    route,
    backwardPickupAllowanceMeters: backwardPickupLimit,
  });

  const extendedDestination = evaluateExtendedDestinationCandidate({
    pickup: params.pickup,
    dropoff: params.dropoff,
    destination,
    route,
    destinationExtensionAllowanceMeters: destinationExtensionLimit,
  });

  // 2. BACKWARD_PICKUP_MATCH: backward pickup + eligible route dropoff
  if (backwardPickup && eligibleDropoffs.length > 0) {
    const validDropoffs = eligibleDropoffs.filter(
      (d) => d.routePositionMeters >= minProgress,
    );
    if (validDropoffs.length > 0) {
      validDropoffs.sort(
        (a, b) =>
          a.distanceFromRouteMeters - b.distanceFromRouteMeters ||
          a.routePositionMeters - b.routePositionMeters,
      );
      const bestDropoff = validDropoffs[0];
      return {
        category: RideMatchCategory.BACKWARD_PICKUP_MATCH,
        isFlexible: true,
        pickupFlexibilityDistanceKm:
          Math.round(backwardPickup.distanceMeters / 100) / 10,
        destinationExtensionDistanceKm: null,
        pickupFlexibilityDistanceMeters: backwardPickup.distanceMeters,
        destinationExtensionDistanceMeters: 0,
        actualDriverPickupLocation: source,
        actualDriverDropLocation: destination,
        requiresIndependentPickupTravel: true,
        requiresIndependentDestinationTravel: false,
        score:
          backwardPickup.distanceMeters + bestDropoff.distanceFromRouteMeters,
      };
    }
  }

  // 3. EXTENDED_DESTINATION_MATCH: eligible route pickup + extended destination
  if (extendedDestination && eligiblePickups.length > 0) {
    const validPickups = eligiblePickups.filter(
      (p) => p.routePositionMeters <= routeLength - minProgress,
    );
    if (validPickups.length > 0) {
      validPickups.sort(
        (a, b) =>
          a.distanceFromRouteMeters - b.distanceFromRouteMeters ||
          a.routePositionMeters - b.routePositionMeters,
      );
      const bestPickup = validPickups[0];
      return {
        category: RideMatchCategory.EXTENDED_DESTINATION_MATCH,
        isFlexible: true,
        pickupFlexibilityDistanceKm: null,
        destinationExtensionDistanceKm:
          Math.round(extendedDestination.distanceMeters / 100) / 10,
        pickupFlexibilityDistanceMeters: 0,
        destinationExtensionDistanceMeters: extendedDestination.distanceMeters,
        actualDriverPickupLocation: source,
        actualDriverDropLocation: destination,
        requiresIndependentPickupTravel: false,
        requiresIndependentDestinationTravel: true,
        score:
          bestPickup.distanceFromRouteMeters +
          extendedDestination.distanceMeters,
      };
    }
  }

  // 4. FLEXIBLE_PICKUP_AND_DESTINATION_MATCH: both backward pickup and extended destination
  if (backwardPickup && extendedDestination) {
    if (routeLength >= minProgress) {
      return {
        category: RideMatchCategory.FLEXIBLE_PICKUP_AND_DESTINATION_MATCH,
        isFlexible: true,
        pickupFlexibilityDistanceKm:
          Math.round(backwardPickup.distanceMeters / 100) / 10,
        destinationExtensionDistanceKm:
          Math.round(extendedDestination.distanceMeters / 100) / 10,
        pickupFlexibilityDistanceMeters: backwardPickup.distanceMeters,
        destinationExtensionDistanceMeters: extendedDestination.distanceMeters,
        actualDriverPickupLocation: source,
        actualDriverDropLocation: destination,
        requiresIndependentPickupTravel: true,
        requiresIndependentDestinationTravel: true,
        score:
          backwardPickup.distanceMeters + extendedDestination.distanceMeters,
      };
    }
  }

  return null;
}
