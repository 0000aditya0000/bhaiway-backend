import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';

import {
  decodePolyline,
  finalizeRouteGeometry,
  haversineMeters,
  isValidLatLng,
  LatLng,
} from './route-geometry';
import {
  DEFAULT_ROUTE_SELECTION_TTL_SECONDS,
  ROUTE_SELECTION_ENDPOINT_TOLERANCE_METERS,
  ROUTE_SELECTION_TOKEN_VERSION,
  RouteSelectionPayload,
  RouteSelectionTokenError,
  signRouteSelectionToken,
  verifyRouteSelectionToken,
} from './route-selection.token';
import type { DrivingRouteOption } from './ride-directions.service';

export interface SelectedRouteFields {
  sourceLatitude: number;
  sourceLongitude: number;
  destinationLatitude: number;
  destinationLongitude: number;
  routePolyline: string;
  routeLengthMeters: number;
  routeBboxMinLat: number;
  routeBboxMaxLat: number;
  routeBboxMinLng: number;
  routeBboxMaxLng: number;
  routeSelectionId: string;
  routeSelectedAt: Date;
  routeDurationSeconds: number | null;
}

@Injectable()
export class RouteSelectionService {
  constructor(private readonly configService: ConfigService) {}

  signOptions(
    options: DrivingRouteOption[],
    ttlSeconds = DEFAULT_ROUTE_SELECTION_TTL_SECONDS,
  ): Array<DrivingRouteOption & { selectionToken: string; optionId: string }> {
    const secret = this.signingSecret();
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    return options.map((option) => {
      const optionId = randomUUID();
      const payload: RouteSelectionPayload = {
        v: ROUTE_SELECTION_TOKEN_VERSION,
        id: optionId,
        slat: option.source.latitude,
        slng: option.source.longitude,
        dlat: option.destination.latitude,
        dlng: option.destination.longitude,
        poly: option.polylineEncoded,
        len: option.lengthMeters,
        dur: option.durationSeconds,
        bbox: option.bbox,
        exp,
      };
      return {
        ...option,
        optionId,
        selectionToken: signRouteSelectionToken(payload, secret),
      };
    });
  }

  resolveSelectedRoute(params: {
    token: string | undefined | null;
    sourceLatitude?: number;
    sourceLongitude?: number;
    destinationLatitude?: number;
    destinationLongitude?: number;
  }): SelectedRouteFields {
    const token = params.token?.trim();
    if (!token) {
      throw new BadRequestException(
        'A selected driving route is required. Request POST /rides/route-options and pass routeSelectionToken.',
      );
    }

    let payload: RouteSelectionPayload;
    try {
      payload = verifyRouteSelectionToken(token, this.signingSecret());
    } catch (error) {
      if (error instanceof RouteSelectionTokenError) {
        throw new BadRequestException(error.message);
      }
      throw new BadRequestException('Route selection token is invalid');
    }

    const tokenSource: LatLng = {
      latitude: payload.slat,
      longitude: payload.slng,
    };
    const tokenDestination: LatLng = {
      latitude: payload.dlat,
      longitude: payload.dlng,
    };
    if (!isValidLatLng(tokenSource) || !isValidLatLng(tokenDestination)) {
      throw new BadRequestException('Route selection token is invalid');
    }

    this.assertEndpointMatches(
      'source',
      { latitude: params.sourceLatitude, longitude: params.sourceLongitude },
      tokenSource,
    );
    this.assertEndpointMatches(
      'destination',
      {
        latitude: params.destinationLatitude,
        longitude: params.destinationLongitude,
      },
      tokenDestination,
    );

    let points;
    try {
      points = decodePolyline(payload.poly);
      finalizeRouteGeometry(points);
    } catch {
      throw new BadRequestException('Route selection token is invalid');
    }
    if (points.length < 2) {
      throw new BadRequestException('Route selection token is invalid');
    }

    return {
      sourceLatitude: tokenSource.latitude,
      sourceLongitude: tokenSource.longitude,
      destinationLatitude: tokenDestination.latitude,
      destinationLongitude: tokenDestination.longitude,
      routePolyline: payload.poly,
      routeLengthMeters: payload.len,
      routeBboxMinLat: payload.bbox.minLat,
      routeBboxMaxLat: payload.bbox.maxLat,
      routeBboxMinLng: payload.bbox.minLng,
      routeBboxMaxLng: payload.bbox.maxLng,
      routeSelectionId: payload.id,
      routeSelectedAt: new Date(),
      routeDurationSeconds:
        payload.dur == null || !Number.isFinite(payload.dur)
          ? null
          : Math.round(payload.dur),
    };
  }

  private assertEndpointMatches(
    label: 'source' | 'destination',
    supplied: { latitude?: number; longitude?: number },
    expected: LatLng,
  ): void {
    if (supplied.latitude == null || supplied.longitude == null) {
      throw new BadRequestException(
        `Provide ${label} coordinates that match the selected route`,
      );
    }
    const point: LatLng = {
      latitude: supplied.latitude,
      longitude: supplied.longitude,
    };
    if (!isValidLatLng(point)) {
      throw new BadRequestException(`Invalid ${label} coordinates`);
    }
    if (
      haversineMeters(point, expected) > ROUTE_SELECTION_ENDPOINT_TOLERANCE_METERS
    ) {
      throw new BadRequestException(
        `Selected route does not match the supplied ${label} coordinates`,
      );
    }
  }

  private signingSecret(): string {
    const secret = this.configService.get<string>('JWT_ACCESS_SECRET')?.trim();
    if (!secret || secret.length < 8) {
      throw new BadRequestException(
        'Route selection is unavailable because JWT_ACCESS_SECRET is not configured',
      );
    }
    return secret;
  }
}
