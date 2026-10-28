import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  BuiltRouteGeometry,
  buildStraightRouteGeometry,
  decodePolyline,
  finalizeRouteGeometry,
  isValidLatLng,
  LatLng,
} from './route-geometry';

export interface ResolvedRouteGeometry extends BuiltRouteGeometry {
  source: LatLng;
  destination: LatLng;
}

export interface DrivingRouteOption extends BuiltRouteGeometry {
  source: LatLng;
  destination: LatLng;
  durationSeconds: number | null;
}

type GoogleDirectionsBody = {
  status?: string;
  error_message?: string;
  routes?: Array<{
    overview_polyline?: { points?: string };
    legs?: Array<{
      start_location?: { lat?: number; lng?: number };
      end_location?: { lat?: number; lng?: number };
      duration?: { value?: number };
    }>;
  }>;
};

/**
 * Google Directions client. Driver-selected routes are listed via
 * {@link listDrivingRouteOptions} and never invented as a straight line.
 * {@link buildRouteGeometry} remains a legacy helper for explicit backfill only.
 */
@Injectable()
export class RideDirectionsService {
  private readonly logger = new Logger('RideDirections');

  constructor(private readonly configService: ConfigService) {}

  async listDrivingRouteOptions(
    source: LatLng,
    destination: LatLng,
  ): Promise<DrivingRouteOption[]> {
    if (!isValidLatLng(source) || !isValidLatLng(destination)) {
      throw new ServiceUnavailableException(
        'Driving route options require valid source and destination coordinates',
      );
    }

    const apiKey = this.googleApiKey();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'Driving route options require GOOGLE_MAPS_API_KEY',
      );
    }

    const body = await this.requestGoogleDirections({
      origin: `${source.latitude},${source.longitude}`,
      destination: `${destination.latitude},${destination.longitude}`,
      apiKey,
      alternatives: true,
    });
    const options = this.parseDrivingOptions(body, source, destination);
    if (options.length === 0) {
      throw new ServiceUnavailableException(
        'No driving routes were returned for the selected source and destination',
      );
    }
    return options;
  }

  /**
   * Legacy helper: Google driving geometry only. Does not invent a straight line.
   */
  async buildDrivingRouteGeometry(
    source: LatLng,
    destination: LatLng,
  ): Promise<DrivingRouteOption | null> {
    if (!isValidLatLng(source) || !isValidLatLng(destination)) {
      return null;
    }
    try {
      const options = await this.listDrivingRouteOptions(source, destination);
      return options[0] ?? null;
    } catch (error) {
      this.logger.warn(
        `[RideDirections] Driving geometry unavailable (${
          error instanceof Error ? error.message : 'unknown'
        })`,
      );
      return null;
    }
  }

  async buildRouteGeometry(
    source: LatLng,
    destination: LatLng,
  ): Promise<BuiltRouteGeometry | null> {
    if (!isValidLatLng(source) || !isValidLatLng(destination)) {
      return null;
    }

    const resolved = await this.fetchGoogleDirections({
      origin: `${source.latitude},${source.longitude}`,
      destination: `${destination.latitude},${destination.longitude}`,
      fallbackSource: source,
      fallbackDestination: destination,
    });
    if (resolved) {
      return resolved;
    }

    return buildStraightRouteGeometry(source, destination);
  }

  /**
   * Resolve a driving corridor from place-name labels (e.g. "Noida", "Haridwar").
   * Requires GOOGLE_MAPS_API_KEY. Returns null when the key is missing or Directions fails.
   */
  async buildRouteGeometryFromPlaceNames(
    sourcePlace: string,
    destinationPlace: string,
  ): Promise<ResolvedRouteGeometry | null> {
    const origin = sourcePlace.trim();
    const destination = destinationPlace.trim();
    if (!origin || !destination) {
      return null;
    }

    return this.fetchGoogleDirections({
      origin,
      destination,
      fallbackSource: null,
      fallbackDestination: null,
    });
  }

  private googleApiKey(): string | null {
    return this.configService.get<string>('GOOGLE_MAPS_API_KEY')?.trim() || null;
  }

  private async requestGoogleDirections(params: {
    origin: string;
    destination: string;
    apiKey: string;
    alternatives: boolean;
  }): Promise<GoogleDirectionsBody> {
    const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
    url.searchParams.set('origin', params.origin);
    url.searchParams.set('destination', params.destination);
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('key', params.apiKey);
    if (params.alternatives) {
      url.searchParams.set('alternatives', 'true');
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as GoogleDirectionsBody;
  }

  private parseDrivingOptions(
    body: GoogleDirectionsBody,
    fallbackSource: LatLng,
    fallbackDestination: LatLng,
  ): DrivingRouteOption[] {
    if (body.status !== 'OK' || !body.routes?.length) {
      return [];
    }
    const options: DrivingRouteOption[] = [];
    for (const route of body.routes) {
      const encoded = route.overview_polyline?.points;
      if (!encoded) {
        continue;
      }
      const points = decodePolyline(encoded);
      if (points.length < 2) {
        continue;
      }
      const geometry = finalizeRouteGeometry(points);
      const firstLeg = route.legs?.[0];
      const lastLeg = route.legs?.[route.legs.length - 1];
      let durationSeconds: number | null = 0;
      for (const leg of route.legs ?? []) {
        const value = leg.duration?.value;
        if (typeof value === 'number' && Number.isFinite(value)) {
          durationSeconds += value;
        } else {
          durationSeconds = null;
          break;
        }
      }
      options.push({
        ...geometry,
        durationSeconds,
        source: {
          latitude: firstLeg?.start_location?.lat ?? fallbackSource.latitude,
          longitude: firstLeg?.start_location?.lng ?? fallbackSource.longitude,
        },
        destination: {
          latitude:
            lastLeg?.end_location?.lat ?? fallbackDestination.latitude,
          longitude:
            lastLeg?.end_location?.lng ?? fallbackDestination.longitude,
        },
      });
    }
    return options;
  }

  private async fetchGoogleDirections(params: {
    origin: string;
    destination: string;
    fallbackSource: LatLng | null;
    fallbackDestination: LatLng | null;
  }): Promise<ResolvedRouteGeometry | null> {
    const apiKey = this.googleApiKey();
    if (!apiKey) {
      if (params.fallbackSource && params.fallbackDestination) {
        const geometry = buildStraightRouteGeometry(
          params.fallbackSource,
          params.fallbackDestination,
        );
        return {
          ...geometry,
          source: params.fallbackSource,
          destination: params.fallbackDestination,
        };
      }
      return null;
    }

    try {
      const body = await this.requestGoogleDirections({
        origin: params.origin,
        destination: params.destination,
        apiKey,
        alternatives: false,
      });
      const options = this.parseDrivingOptions(
        body,
        params.fallbackSource ?? { latitude: 0, longitude: 0 },
        params.fallbackDestination ?? { latitude: 0, longitude: 0 },
      );
      const option = options[0];
      if (!option) {
        throw new Error(
          `Directions status=${body.status ?? 'unknown'}${
            body.error_message ? `: ${body.error_message}` : ''
          }`,
        );
      }
      return option;
    } catch (error) {
      this.logger.warn(
        `[RideDirections] Google Directions failed for "${params.origin}" → "${params.destination}" (${
          error instanceof Error ? error.message : 'unknown'
        })`,
      );
      if (params.fallbackSource && params.fallbackDestination) {
        const geometry = buildStraightRouteGeometry(
          params.fallbackSource,
          params.fallbackDestination,
        );
        return {
          ...geometry,
          source: params.fallbackSource,
          destination: params.fallbackDestination,
        };
      }
      return null;
    }
  }
}
