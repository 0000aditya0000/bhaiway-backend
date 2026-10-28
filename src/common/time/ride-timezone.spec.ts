import {
  RIDE_TIME_ZONE,
  civilDateTimeToUtcMs,
  currentCivilClock,
  toCivilDateString,
} from './ride-timezone';

describe('ride-timezone (Asia/Kolkata policy)', () => {
  it('exports Asia/Kolkata as the ride timezone', () => {
    expect(RIDE_TIME_ZONE).toBe('Asia/Kolkata');
  });

  it('maps civil IST wall-clock to a fixed UTC instant independent of process TZ', () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      const west = civilDateTimeToUtcMs('2026-06-15', '10:00:00');
      process.env.TZ = 'UTC';
      const utc = civilDateTimeToUtcMs('2026-06-15', '10:00:00');
      process.env.TZ = 'Asia/Tokyo';
      const tokyo = civilDateTimeToUtcMs('2026-06-15', '10:00:00');

      // 10:00 Asia/Kolkata = 04:30 UTC
      const expected = Date.UTC(2026, 5, 15, 4, 30, 0);
      expect(west).toBe(expected);
      expect(utc).toBe(expected);
      expect(tokyo).toBe(expected);
    } finally {
      if (previous === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previous;
      }
    }
  });

  it('currentCivilClock returns Kolkata civil date/time for a known UTC instant', () => {
    // 2026-06-15 04:30 UTC = 10:00 Asia/Kolkata
    const clock = currentCivilClock(new Date(Date.UTC(2026, 5, 15, 4, 30, 0)));
    expect(clock).toEqual({ date: '2026-06-15', time: '10:00:00' });
  });

  it('toCivilDateString keeps PostgreSQL DATE values on the Asia/Kolkata civil day', () => {
    expect(toCivilDateString('2026-11-04')).toBe('2026-11-04');
    expect(toCivilDateString('2026-11-04T00:00:00')).toBe('2026-11-04');

    const utcMidnight = new Date(Date.UTC(2026, 10, 4, 0, 0, 0, 0));
    expect(toCivilDateString(utcMidnight)).toBe('2026-11-04');

    const localMidnight = new Date(2026, 10, 4, 0, 0, 0, 0);
    const localYmd = `${localMidnight.getFullYear()}-${String(
      localMidnight.getMonth() + 1,
    ).padStart(2, '0')}-${String(localMidnight.getDate()).padStart(2, '0')}`;
    expect(toCivilDateString(localMidnight)).toBe(localYmd);

    // IST local midnight is the previous UTC calendar day when sliced via ISO.
    if (localMidnight.getTimezoneOffset() < 0) {
      expect(localMidnight.toISOString().slice(0, 10)).not.toBe(
        toCivilDateString(localMidnight),
      );
    }

    // 20:00 UTC 3 Nov = 01:30 Asia/Kolkata 4 Nov
    expect(toCivilDateString(new Date(Date.UTC(2026, 10, 3, 20, 0, 0)))).toBe(
      '2026-11-04',
    );
  });
});
