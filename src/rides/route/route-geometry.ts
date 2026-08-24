/**
 * Route corridor helpers for ride search.
 * Pure geometry — no Nest/DB dependencies.
 */

export const ROUTE_CORRIDOR_MAX_METERS = 50_000;
/** Minimum along-route separation between pickup and dropoff projections. */
export const ROUTE_MIN_PROGRESS_METERS = 50;
/** Densify geodesic segments about every N meters for projection accuracy. */
export const ROUTE_DENSIFY_STEP_METERS = 2_000;

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
): { point: LatLng; t: number } {
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
    return { point: a, t: 0 };
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return {
    point: {
      latitude: ay + t * dy,
      longitude: ax + t * dx,
    },
    t,
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
