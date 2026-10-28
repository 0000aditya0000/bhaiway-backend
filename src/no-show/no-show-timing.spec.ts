import { parseCivilDeparture } from '../assured/assured-timing';
import { currentCivilClock } from '../common/time/ride-timezone';

import { NO_SHOW_ELIGIBLE_AFTER_MS } from './no-show.constants';
import { isNoShowEligible, noShowEligibleAt } from './no-show-timing';

describe('No-Show eligibility timing (Asia/Kolkata)', () => {
  it('becomes eligible at exactly departure + 5 minutes and not 1ms earlier', () => {
    const departure = parseCivilDeparture('2026-06-15', '10:00:00');
    const eligibleAt = noShowEligibleAt('2026-06-15', '10:00:00');
    expect(eligibleAt.getTime() - departure.getTime()).toBe(
      NO_SHOW_ELIGIBLE_AFTER_MS,
    );

    expect(
      isNoShowEligible(
        new Date(eligibleAt.getTime() - 1),
        '2026-06-15',
        '10:00:00',
      ),
    ).toBe(false);
    expect(
      isNoShowEligible(eligibleAt, '2026-06-15', '10:00:00'),
    ).toBe(true);
  });

  it('uses Kolkata civil departure independent of process timezone', () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      const clock = currentCivilClock(new Date(Date.UTC(2026, 5, 15, 4, 30, 0)));
      expect(clock).toEqual({ date: '2026-06-15', time: '10:00:00' });
      expect(isNoShowEligible(new Date(Date.UTC(2026, 5, 15, 4, 34, 59)), clock.date, clock.time)).toBe(
        false,
      );
      expect(isNoShowEligible(new Date(Date.UTC(2026, 5, 15, 4, 35, 0)), clock.date, clock.time)).toBe(
        true,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previous;
      }
    }
  });
});
