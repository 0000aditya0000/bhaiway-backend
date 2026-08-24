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

/**
 * Builds route geometry once at ride publish/update.
 * Prefer Google Directions overview polyline when GOOGLE_MAPS_API_KEY is set;
 * otherwise densified geodesic between endpoints (no external call).
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

    const apiKey = this.configService.get<string>('GOOGLE_MAPS_API_KEY')?.trim();
    if (apiKey) {
      try {
        const google = await this.fetchGoogleOverviewPolyline(
          source,
          destination,
          apiKey,
        );
        if (google) {
          return google;
        }
      } catch (error) {
        this.logger.warn(
          `[RideDirections] Google Directions failed; using geodesic fallback (${
            error instanceof Error ? error.message : 'unknown'
          })`,
        );
      }
    }

    return buildStraightRouteGeometry(source, destination);
  }

  private async fetchGoogleOverviewPolyline(
    source: LatLng,
    destination: LatLng,
    apiKey: string,
  ): Promise<BuiltRouteGeometry | null> {
    const origin = `${source.latitude},${source.longitude}`;
    const dest = `${destination.latitude},${destination.longitude}`;
    const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
    url.searchParams.set('origin', origin);
    url.searchParams.set('destination', dest);
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('key', apiKey);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      status?: string;
      routes?: Array<{ overview_polyline?: { points?: string } }>;
    };
    if (body.status !== 'OK' || !body.routes?.[0]?.overview_polyline?.points) {
      throw new Error(`Directions status=${body.status ?? 'unknown'}`);
    }
    const encoded = body.routes[0].overview_polyline.points;
    const points = decodePolyline(encoded);
    if (points.length < 2) {
      throw new Error('Directions returned empty polyline');
    }
    return finalizeRouteGeometry(points);
  }
}
