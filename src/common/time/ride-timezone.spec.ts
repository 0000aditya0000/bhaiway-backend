import {
  RIDE_TIME_ZONE,
  civilDateTimeToUtcMs,
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
});
