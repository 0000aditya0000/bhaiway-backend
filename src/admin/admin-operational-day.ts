/** Asia/Kolkata operational-day helpers for admin dashboard metrics. */

export const ADMIN_DASHBOARD_TIMEZONE = 'Asia/Kolkata';

export interface OperationalDayWindow {
  timezone: typeof ADMIN_DASHBOARD_TIMEZONE;
  /** Inclusive start (UTC Date). */
  start: Date;
  /** Exclusive end (UTC Date). */
  end: Date;
  startIso: string;
  endIso: string;
}

/**
 * Returns [start, end) for the current civil day in Asia/Kolkata,
 * expressed as UTC Date objects safe for timestamptz comparisons.
 */
export function getAsiaKolkataOperationalDay(
  now: Date = new Date(),
): OperationalDayWindow {
  const parts = getZonedParts(now, ADMIN_DASHBOARD_TIMEZONE);
  const start = zonedCivilTimeToUtc(
    parts.year,
    parts.month,
    parts.day,
    0,
    0,
    0,
    0,
    ADMIN_DASHBOARD_TIMEZONE,
  );
  const nextCivil = addOneCivilDay(parts.year, parts.month, parts.day);
  const end = zonedCivilTimeToUtc(
    nextCivil.year,
    nextCivil.month,
    nextCivil.day,
    0,
    0,
    0,
    0,
    ADMIN_DASHBOARD_TIMEZONE,
  );

  return {
    timezone: ADMIN_DASHBOARD_TIMEZONE,
    start,
    end,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function getZonedParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const bags = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(bags.year),
    month: Number(bags.month),
    day: Number(bags.day),
  };
}

function addOneCivilDay(
  year: number,
  month: number,
  day: number,
): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

/**
 * Convert a civil wall-clock time in `timeZone` to a UTC Date.
 * Uses iterative offset resolution (handles IST fixed offset and DST zones).
 */
function zonedCivilTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string,
): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  for (let i = 0; i < 3; i += 1) {
    const offsetMs = getTimeZoneOffsetMs(new Date(guess), timeZone);
    const next = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMs;
    if (next === guess) {
      break;
    }
    guess = next;
  }
  return new Date(guess);
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}
