import {
  RIDE_TIME_ZONE,
  civilDateTimeToDate,
} from '../common/time/ride-timezone';

/**
 * Half-time = createdAt + (departureDateTime - createdAt) / 2
 *
 * Departure civil date/time is interpreted in {@link RIDE_TIME_ZONE} (Asia/Kolkata),
 * never in the Node process local timezone.
 */
export function calculateAssuredHalfTime(
  createdAt: Date,
  departureDate: string,
  departureTime: string,
): Date {
  const departure = parseCivilDeparture(departureDate, departureTime);
  const createdMs = createdAt.getTime();
  const departureMs = departure.getTime();
  if (departureMs < createdMs) {
    return new Date(createdMs);
  }
  const halfMs = createdMs + Math.floor((departureMs - createdMs) / 2);
  return new Date(halfMs);
}

/** Parse ride civil departure in the BhaiWay ride timezone (Asia/Kolkata). */
export function parseCivilDeparture(
  departureDate: string,
  departureTime: string,
): Date {
  return civilDateTimeToDate(departureDate, departureTime, RIDE_TIME_ZONE);
}

export function isAtOrAfterDeparture(
  now: Date,
  departureDate: string,
  departureTime: string,
): boolean {
  return (
    now.getTime() >=
    parseCivilDeparture(departureDate, departureTime).getTime()
  );
}

export function isBeforeDeparture(
  now: Date,
  departureDate: string,
  departureTime: string,
): boolean {
  return !isAtOrAfterDeparture(now, departureDate, departureTime);
}
