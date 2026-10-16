/**
 * Calendar-month window math for commute rewards.
 *
 * Decision (documented): milestone windows are N calendar months from
 * `campaign.startsAt` in the campaign's IANA timezone — not fixed 30-day spans.
 *
 * Algorithm: read Y/M/D/H/M/S in the campaign TZ, add `months` to the calendar
 * month (clamping day-of-month on overflow), then resolve back to a UTC Instant
 * at the same local wall time via iterative offset matching.
 */

function zonedParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const map = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addMonthsToParts(
  parts: ReturnType<typeof zonedParts>,
  months: number,
): ReturnType<typeof zonedParts> {
  const totalMonths = parts.year * 12 + (parts.month - 1) + months;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  const dim = daysInMonth(year, month);
  const day = Math.min(parts.day, dim);
  return { ...parts, year, month, day };
}

function zonedLocalToUtc(
  parts: ReturnType<typeof zonedParts>,
  timeZone: string,
): Date {
  // Initial guess as UTC, then correct by timezone offset twice.
  let utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  for (let i = 0; i < 3; i++) {
    const asDate = new Date(utcGuess);
    const got = zonedParts(asDate, timeZone);
    const gotUtc = Date.UTC(
      got.year,
      got.month - 1,
      got.day,
      got.hour,
      got.minute,
      got.second,
    );
    const wantUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    utcGuess += wantUtc - gotUtc;
  }
  return new Date(utcGuess);
}

/** Exclusive window end: start + N calendar months in `timeZone`. */
export function addCalendarMonthsInTimeZone(
  start: Date,
  months: number,
  timeZone: string,
): Date {
  if (!Number.isInteger(months) || months < 1) {
    throw new Error('months must be a positive integer');
  }
  const parts = zonedParts(start, timeZone);
  const endParts = addMonthsToParts(parts, months);
  return zonedLocalToUtc(endParts, timeZone);
}

export function isWithinWindow(
  completedAt: Date,
  windowStartInclusive: Date,
  windowEndExclusive: Date,
): boolean {
  return (
    completedAt.getTime() >= windowStartInclusive.getTime() &&
    completedAt.getTime() < windowEndExclusive.getTime()
  );
}
