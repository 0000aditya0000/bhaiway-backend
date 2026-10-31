export type CancellationActor = 'passenger' | 'driver' | 'admin' | 'system';

export interface RideCancellationSnapshot {
  source?: string | null;
  destination?: string | null;
  departureDate?: string | Date | null;
  departureTime?: string | null;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function humanizeCancellationActor(actor: CancellationActor): string {
  switch (actor) {
    case 'passenger':
      return 'The passenger';
    case 'driver':
      return 'The driver';
    case 'admin':
      return 'BhaiWay Operations';
    default:
      return 'BhaiWay';
  }
}

export function humanizeCancellationReason(
  reason?: string | null,
): string | null {
  if (!reason) {
    return null;
  }
  switch (reason) {
    case 'RIDER_CANCELLED':
      return 'Passenger cancelled';
    case 'RIDE_CANCELLED':
      return 'Driver cancelled the ride';
    case 'ADMIN_CANCELLED':
      return 'Cancelled by BhaiWay Operations';
    case 'DRIVER_REJECTED':
      return 'Driver declined the request';
    case 'COMMUTE_RIDE_FULL':
      return 'The ride is full';
    case 'DRIVER_NO_SHOW':
      return 'Driver no-show';
    case 'RIDER_NO_SHOW':
      return 'Passenger no-show';
    default:
      return reason.replace(/_/g, ' ').toLowerCase();
  }
}

export function toCivilDate(value: string | Date | null | undefined): string {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatCivilDate(value: string | Date | null | undefined): string {
  const civil = toCivilDate(value);
  if (!civil) {
    return '';
  }
  const [year, month, day] = civil.split('-');
  const monthIndex = Number(month) - 1;
  if (!year || monthIndex < 0 || monthIndex > 11 || !day) {
    return civil;
  }
  return `${Number(day)} ${MONTHS[monthIndex]} ${year}`;
}

export function formatWallClock(value?: string | null): string {
  if (!value) {
    return '';
  }
  return value.slice(0, 5);
}

export function formatRideRoute(
  source?: string | null,
  destination?: string | null,
): string {
  const from = source?.trim() ?? '';
  const to = destination?.trim() ?? '';
  if (from && to) {
    return `${from} → ${to}`;
  }
  return from || to;
}

export function formatRideWhen(snapshot: RideCancellationSnapshot): string {
  const date = formatCivilDate(snapshot.departureDate);
  const time = formatWallClock(snapshot.departureTime);
  if (date && time) {
    return `${date} at ${time}`;
  }
  return date || time;
}

export function buildCancellationBody(params: {
  fallback: string;
  actor?: CancellationActor;
  snapshot?: RideCancellationSnapshot | null;
  cancellationReason?: string | null;
  bookingId?: string | null;
  rideId?: string | null;
}): string {
  const parts: string[] = [params.fallback.trim()];
  const actor = params.actor
    ? humanizeCancellationActor(params.actor)
    : null;
  const route = params.snapshot
    ? formatRideRoute(params.snapshot.source, params.snapshot.destination)
    : '';
  const when = params.snapshot ? formatRideWhen(params.snapshot) : '';
  const reason = humanizeCancellationReason(params.cancellationReason);

  const detail: string[] = [];
  if (actor) {
    detail.push(actor);
  }
  if (route) {
    detail.push(route);
  }
  if (when) {
    detail.push(when);
  }
  if (detail.length > 0) {
    if (actor && route && when) {
      parts.push(`${actor} cancelled ${route} on ${when}.`);
    } else {
      parts.push(detail.join(' · ') + '.');
    }
  }
  if (reason) {
    parts.push(`Reason: ${reason}.`);
  }
  if (params.bookingId) {
    parts.push(`Booking ID: ${params.bookingId}.`);
  }
  if (params.rideId) {
    parts.push(`Ride ID: ${params.rideId}.`);
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function cancellationDataFields(params: {
  snapshot?: RideCancellationSnapshot | null;
  cancelledBy?: CancellationActor;
  cancellationReason?: string | null;
}): Record<string, string | null> {
  const snapshot = params.snapshot;
  return {
    cancelledBy: params.cancelledBy ?? null,
    cancellationReason: params.cancellationReason ?? null,
    source: snapshot?.source?.trim() || null,
    destination: snapshot?.destination?.trim() || null,
    departureDate: toCivilDate(snapshot?.departureDate) || null,
    departureTime: formatWallClock(snapshot?.departureTime) || null,
  };
}
