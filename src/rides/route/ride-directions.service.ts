import { Injectable, Logger } from '@nestjs/common';
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

/**
 * Builds route geometry once at ride publish/update (and optional search backfill).
 * Prefer Google Directions overview polyline when GOOGLE_MAPS_API_KEY is set;
 * otherwise densified geodesic between coordinate endpoints (no external call).
 *
 * Place-name only publishes use Directions with address origin/destination so
 * corridor search works even when the app omits lat/lng.
 */
@Injectable()
export class RideDirectionsService {
  private readonly logger = new Logger('RideDirections');

  constructor(private readonly configService: ConfigService) {}

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

  private async fetchGoogleDirections(params: {
    origin: string;
    destination: string;
    fallbackSource: LatLng | null;
    fallbackDestination: LatLng | null;
  }): Promise<ResolvedRouteGeometry | null> {
    const apiKey = this.configService.get<string>('GOOGLE_MAPS_API_KEY')?.trim();
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
      const url = new URL(
        'https://maps.googleapis.com/maps/api/directions/json',
      );
      url.searchParams.set('origin', params.origin);
      url.searchParams.set('destination', params.destination);
      url.searchParams.set('mode', 'driving');
      url.searchParams.set('key', apiKey);

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        status?: string;
        error_message?: string;
        routes?: Array<{
          overview_polyline?: { points?: string };
          legs?: Array<{
            start_location?: { lat?: number; lng?: number };
            end_location?: { lat?: number; lng?: number };
          }>;
        }>;
      };
      if (body.status !== 'OK' || !body.routes?.[0]?.overview_polyline?.points) {
        throw new Error(
          `Directions status=${body.status ?? 'unknown'}${
            body.error_message ? `: ${body.error_message}` : ''
          }`,
        );
      }

      const route = body.routes[0];
      const encoded = route.overview_polyline!.points!;
      const points = decodePolyline(encoded);
      if (points.length < 2) {
        throw new Error('Directions returned empty polyline');
      }

      const geometry = finalizeRouteGeometry(points);
      const leg = route.legs?.[0];
      const source: LatLng = {
        latitude: leg?.start_location?.lat ?? points[0].latitude,
        longitude: leg?.start_location?.lng ?? points[0].longitude,
      };
      const destination: LatLng = {
        latitude:
          leg?.end_location?.lat ?? points[points.length - 1].latitude,
        longitude:
          leg?.end_location?.lng ?? points[points.length - 1].longitude,
      };

      return { ...geometry, source, destination };
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
