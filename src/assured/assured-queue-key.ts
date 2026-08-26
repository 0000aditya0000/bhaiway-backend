import { calculateAssuranceWindow } from './assured-window.math';

/** Coordinate precision (~11 m) for stable endpoint identity. */
const COORD_DECIMALS = 4;

export interface RouteIdentityInput {
  source: string;
  destination: string;
  sourceLatitude?: number | null;
  sourceLongitude?: number | null;
  destinationLatitude?: number | null;
  destinationLongitude?: number | null;
}

export interface AssuredQueueIdentity {
  routeIdentity: string;
  departureDate: string;
  windowId: string;
  queueKey: string;
  assuranceWindowStart: string;
  assuranceWindowEnd: string;
}

function normalizePlaceName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function roundCoord(value: number): string {
  return value.toFixed(COORD_DECIMALS);
}

function hasAllCoordinates(input: RouteIdentityInput): boolean {
  return (
    input.sourceLatitude != null &&
    input.sourceLongitude != null &&
    input.destinationLatitude != null &&
    input.destinationLongitude != null &&
    !Number.isNaN(input.sourceLatitude) &&
    !Number.isNaN(input.sourceLongitude) &&
    !Number.isNaN(input.destinationLatitude) &&
    !Number.isNaN(input.destinationLongitude)
  );
}

/**
 * Deterministic route identity for queue competition (not search corridor matching).
 *
 * When all four endpoint coordinates are present, identity is coordinate-based so
 * "Noida → Dehradun" and "Noida → Haridwar" never share a queue even if search
 * corridors overlap. Otherwise falls back to normalized place names.
 */
export function buildRouteIdentity(input: RouteIdentityInput): string {
  if (hasAllCoordinates(input)) {
    return [
      'coord',
      roundCoord(input.sourceLatitude!),
      roundCoord(input.sourceLongitude!),
      roundCoord(input.destinationLatitude!),
      roundCoord(input.destinationLongitude!),
    ].join(':');
  }

  return `name:${normalizePlaceName(input.source)}|${normalizePlaceName(input.destination)}`;
}

export function buildAssuredQueueKey(params: {
  routeIdentity: string;
  departureDate: string;
  windowId: string;
}): string {
  return `${params.routeIdentity}|${params.departureDate.trim()}|${params.windowId}`;
}

export function calculateAssuredQueueIdentity(
  input: RouteIdentityInput & {
    departureDate: string;
    departureTime: string;
  },
): AssuredQueueIdentity {
  const window = calculateAssuranceWindow(
    input.departureDate,
    input.departureTime,
  );
  const routeIdentity = buildRouteIdentity(input);

  return {
    routeIdentity,
    departureDate: input.departureDate.trim(),
    windowId: window.windowId,
    queueKey: buildAssuredQueueKey({
      routeIdentity,
      departureDate: input.departureDate,
      windowId: window.windowId,
    }),
    assuranceWindowStart: window.windowStartTime,
    assuranceWindowEnd: window.windowEndTime,
  };
}
