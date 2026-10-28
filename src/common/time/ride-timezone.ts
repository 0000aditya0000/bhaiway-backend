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
