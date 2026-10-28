/**
 * BhaiWay ride civil date/time policy.
 *
 * Rides store departure as civil calendar date + wall-clock time (no TZ column).
 * All Assured lifecycle timing interprets those civil values in this fixed zone.
 * Do not use the Node process timezone and do not accept client timezones.
 */
export const RIDE_TIME_ZONE = 'Asia/Kolkata' as const;

/**
 * Convert a civil date + wall-clock time in `timeZone` to a UTC epoch ms instant.
 * Uses Intl offset resolution (India has no DST; still correct for Asia/Kolkata).
 */
export function civilDateTimeToUtcMs(
  departureDate: string,
  departureTime: string,
  timeZone: string = RIDE_TIME_ZONE,
): number {
  const time =
    departureTime.length >= 8
      ? departureTime.slice(0, 8)
      : `${departureTime}:00`.slice(0, 8);
  const [year, month, day] = departureDate.split('-').map(Number);
  const [hour, minute, second] = time.split(':').map(Number);

  // Initial guess: treat civil components as UTC, then subtract the zone offset
  // at that instant so the civil clock matches `timeZone`.
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second || 0);
  const offset1 = getTimeZoneOffsetMs(timeZone, new Date(utcMs));
  utcMs = Date.UTC(year, month - 1, day, hour, minute, second || 0) - offset1;

  // One correction pass for zones with DST transitions (no-op for Asia/Kolkata).
  const offset2 = getTimeZoneOffsetMs(timeZone, new Date(utcMs));
  if (offset2 !== offset1) {
    utcMs = Date.UTC(year, month - 1, day, hour, minute, second || 0) - offset2;
  }

  return utcMs;
}

export function civilDateTimeToDate(
  departureDate: string,
  departureTime: string,
  timeZone: string = RIDE_TIME_ZONE,
): Date {
  return new Date(civilDateTimeToUtcMs(departureDate, departureTime, timeZone));
}

/**
 * Current civil calendar date (YYYY-MM-DD) and wall-clock time (HH:mm:ss)
 * in `timeZone`. Used to exclude already-departed rides from retrieval.
 */
export function currentCivilClock(
  now: Date = new Date(),
  timeZone: string = RIDE_TIME_ZONE,
): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '00';
  const hourRaw = get('hour');
  const hour = hourRaw === '24' ? '00' : hourRaw;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}:${get('second')}`,
  };
}

/**
 * Add `days` to a civil YYYY-MM-DD date using calendar arithmetic only
 * (not the process timezone and not UTC-midnight local conversion).
 */
export function addCivilDays(departureDate: string, days: number): string {
  const [year, month, day] = departureDate.split('-').map(Number);
  const utc = Date.UTC(year, month - 1, day + days);
  const dt = new Date(utc);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Inclusive civil date range of `length` days starting at `startDate`. */
export function listCivilDateRange(
  startDate: string,
  length: number,
): string[] {
  if (length <= 0) {
    return [];
  }
  const dates: string[] = [];
  for (let offset = 0; offset < length; offset += 1) {
    dates.push(addCivilDays(startDate, offset));
  }
  return dates;
}

/**
 * Normalize a PostgreSQL DATE / civil YYYY-MM-DD value to YYYY-MM-DD.
 *
 * node-pg often hydrates DATE as a local-midnight `Date`. On Asia/Kolkata
 * hosts that instant is the previous calendar day in UTC, so
 * `value.toISOString().slice(0, 10)` shifts THIS_AND_FUTURE bounds backward.
 * Never convert date-only values through UTC ISO slicing.
 */
export function toCivilDateString(value: string | Date): string {
  if (!(value instanceof Date)) {
    return String(value).slice(0, 10);
  }

  const utcMidnight =
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0;
  const localMidnight =
    value.getHours() === 0 &&
    value.getMinutes() === 0 &&
    value.getSeconds() === 0 &&
    value.getMilliseconds() === 0;

  if (utcMidnight) {
    return formatCivilYmd(
      value.getUTCFullYear(),
      value.getUTCMonth() + 1,
      value.getUTCDate(),
    );
  }
  if (localMidnight) {
    return formatCivilYmd(
      value.getFullYear(),
      value.getMonth() + 1,
      value.getDate(),
    );
  }
  return currentCivilClock(value).date;
}

function formatCivilYmd(year: number, month: number, day: number): string {
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

/** Offset of `timeZone` east of UTC at `date`, in milliseconds. */
function getTimeZoneOffsetMs(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour) % 24,
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - date.getTime();
}
