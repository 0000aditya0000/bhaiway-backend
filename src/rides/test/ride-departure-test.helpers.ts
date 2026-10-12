import { RIDE_TIME_ZONE, civilDateTimeToDate } from '../../common/time/ride-timezone';

/** Civil YYYY-MM-DD in Asia/Kolkata, `daysAhead` days from now (default 7). */
export function futureCivilDate(daysAhead = 7): string {
  const now = new Date();
  const kolkataNow = new Date(
    now.toLocaleString('en-US', { timeZone: RIDE_TIME_ZONE }),
  );
  kolkataNow.setDate(kolkataNow.getDate() + daysAhead);
  const y = kolkataNow.getFullYear();
  const m = String(kolkataNow.getMonth() + 1).padStart(2, '0');
  const d = String(kolkataNow.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Past civil date for negative publish tests. */
export function pastCivilDate(daysBehind = 1): string {
  return futureCivilDate(-Math.abs(daysBehind));
}

/** Wall-clock HH:mm:ss that is already past "today" in Asia/Kolkata (or near-past). */
export function pastCivilTimeToday(): { departureDate: string; departureTime: string } {
  const now = new Date();
  const departure = new Date(now.getTime() - 60_000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: RIDE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(departure);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return {
    departureDate: `${get('year')}-${get('month')}-${get('day')}`,
    departureTime: `${get('hour')}:${get('minute')}:${get('second')}`,
  };
}

/** Departure equal to "now" (within the same second) for EQUAL boundary tests. */
export function currentCivilDeparture(): {
  departureDate: string;
  departureTime: string;
} {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: RIDE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return {
    departureDate: `${get('year')}-${get('month')}-${get('day')}`,
    departureTime: `${get('hour')}:${get('minute')}:${get('second')}`,
  };
}

export function assertParsedIsPast(
  departureDate: string,
  departureTime: string,
): void {
  const dep = civilDateTimeToDate(departureDate, departureTime, RIDE_TIME_ZONE);
  if (dep.getTime() > Date.now()) {
    throw new Error('Expected past departure for test setup');
  }
}
