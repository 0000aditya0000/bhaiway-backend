import { randomUUID } from 'crypto';

import { buildStraightRouteGeometry } from '../route/route-geometry';
import {
  DEFAULT_ROUTE_SELECTION_TTL_SECONDS,
  ROUTE_SELECTION_TOKEN_VERSION,
  signRouteSelectionToken,
} from '../route/route-selection.token';

export const SELECTED_ROUTE_TEST_ENDPOINTS = {
  sourceLatitude: 28.5355,
  sourceLongitude: 77.391,
  destinationLatitude: 28.6139,
  destinationLongitude: 77.209,
};

export function mintSelectedRouteToken(params: {
  sourceLatitude: number;
  sourceLongitude: number;
  destinationLatitude: number;
  destinationLongitude: number;
  durationSeconds?: number | null;
  ttlSeconds?: number;
  expired?: boolean;
}): string {
  const secret = process.env.JWT_ACCESS_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new Error(
      'JWT_ACCESS_SECRET is required to mint route selection tokens',
    );
  }
  const source = {
    latitude: params.sourceLatitude,
    longitude: params.sourceLongitude,
  };
  const destination = {
    latitude: params.destinationLatitude,
    longitude: params.destinationLongitude,
  };
  const geometry = buildStraightRouteGeometry(source, destination);
  const ttl = params.ttlSeconds ?? DEFAULT_ROUTE_SELECTION_TTL_SECONDS;
  const exp = params.expired
    ? Math.floor(Date.now() / 1000) - 60
    : Math.floor(Date.now() / 1000) + ttl;
  return signRouteSelectionToken(
    {
      v: ROUTE_SELECTION_TOKEN_VERSION,
      id: randomUUID(),
      slat: source.latitude,
      slng: source.longitude,
      dlat: destination.latitude,
      dlng: destination.longitude,
      poly: geometry.polylineEncoded,
      len: geometry.lengthMeters,
      dur: params.durationSeconds ?? 3600,
      bbox: geometry.bbox,
      exp,
    },
    secret,
  );
}

export function withSelectedRoute<T extends Record<string, unknown>>(
  payload: T,
): T & {
  sourceLatitude: number;
  sourceLongitude: number;
  destinationLatitude: number;
  destinationLongitude: number;
  routeSelectionToken: string;
} {
  const coords = {
    sourceLatitude: Number(
      payload.sourceLatitude ?? SELECTED_ROUTE_TEST_ENDPOINTS.sourceLatitude,
    ),
    sourceLongitude: Number(
      payload.sourceLongitude ?? SELECTED_ROUTE_TEST_ENDPOINTS.sourceLongitude,
    ),
    destinationLatitude: Number(
      payload.destinationLatitude ??
        SELECTED_ROUTE_TEST_ENDPOINTS.destinationLatitude,
    ),
    destinationLongitude: Number(
      payload.destinationLongitude ??
        SELECTED_ROUTE_TEST_ENDPOINTS.destinationLongitude,
    ),
  };
  return {
    ...payload,
    ...coords,
    routeSelectionToken:
      typeof payload.routeSelectionToken === 'string' &&
      payload.routeSelectionToken.trim().length > 0
        ? payload.routeSelectionToken
        : mintSelectedRouteToken(coords),
  };
}
