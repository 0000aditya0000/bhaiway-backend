import { LatLng } from './route-geometry';

export const RoadDistanceStatus = {
  OK: 'OK',
  NO_ROUTE: 'NO_ROUTE',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  TIMEOUT: 'TIMEOUT',
} as const;

export type RoadDistanceStatus =
  (typeof RoadDistanceStatus)[keyof typeof RoadDistanceStatus];

export interface RoadDistanceResult {
  distanceMeters: number | null;
  durationSeconds?: number | null;
  status: RoadDistanceStatus;
  provider: string;
  source: 'cache' | 'network' | 'negative_cache' | 'mock';
  errorMessage?: string;
}

export interface CoordinatePair {
  origin: LatLng;
  destination: LatLng;
}

export interface IRoadRoutingProvider {
  readonly name: string;
  calculateDrivingDistance(
    origin: LatLng,
    destination: LatLng,
    timeoutMs: number,
  ): Promise<RoadDistanceResult>;
  calculateBatchDrivingDistances?(
    pairs: CoordinatePair[],
    timeoutMs: number,
  ): Promise<RoadDistanceResult[]>;
}
