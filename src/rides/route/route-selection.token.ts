import { createHmac, timingSafeEqual } from 'crypto';

import type { RouteBoundingBox } from './route-geometry';

export const ROUTE_SELECTION_TOKEN_VERSION = 1;
export const DEFAULT_ROUTE_SELECTION_TTL_SECONDS = 15 * 60;
export const ROUTE_SELECTION_ENDPOINT_TOLERANCE_METERS = 150;

export interface RouteSelectionPayload {
  v: typeof ROUTE_SELECTION_TOKEN_VERSION;
  id: string;
  slat: number;
  slng: number;
  dlat: number;
  dlng: number;
  poly: string;
  len: number;
  dur: number | null;
  bbox: RouteBoundingBox;
  exp: number;
}

export class RouteSelectionTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteSelectionTokenError';
  }
}

function base64UrlEncode(value: Buffer | string): string {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function hmacDigest(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

export function signRouteSelectionToken(
  payload: RouteSelectionPayload,
  secret: string,
): string {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(hmacDigest(body, secret));
  return `${body}.${signature}`;
}

export function verifyRouteSelectionToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): RouteSelectionPayload {
  const trimmed = token.trim();
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) {
    throw new RouteSelectionTokenError('Route selection token is malformed');
  }
  const body = trimmed.slice(0, dot);
  const signature = trimmed.slice(dot + 1);
  const expected = hmacDigest(body, secret);
  let actual: Buffer;
  try {
    actual = base64UrlDecode(signature);
  } catch {
    throw new RouteSelectionTokenError('Route selection token is malformed');
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new RouteSelectionTokenError('Route selection token is invalid');
  }

  let parsed: RouteSelectionPayload;
  try {
    parsed = JSON.parse(base64UrlDecode(body).toString('utf8')) as RouteSelectionPayload;
  } catch {
    throw new RouteSelectionTokenError('Route selection token is malformed');
  }

  if (parsed?.v !== ROUTE_SELECTION_TOKEN_VERSION || !parsed.poly || !parsed.id) {
    throw new RouteSelectionTokenError('Route selection token is invalid');
  }
  if (typeof parsed.exp !== 'number' || parsed.exp * 1000 <= nowMs) {
    throw new RouteSelectionTokenError('Route selection has expired');
  }
  return parsed;
}
