import { addCivilDays, listCivilDateRange } from '../common/time/ride-timezone';
import {
  commutePublishFingerprint,
  commuteRecurrenceWindow,
  eligibleCommuteOccurrenceDates,
  isCommuteSeriesPublish,
  isReturnAfterOutbound,
  normalizeExcludedWeekdays,
  weekdayOfCivilDate,
} from './commute-recurrence';
import { Weekday } from './enums/ride.enums';

describe('commute recurrence helpers', () => {
  it('builds a 7-calendar-day window including the publishing date', () => {
    const window = commuteRecurrenceWindow('2026-10-29');
    expect(window.startDate).toBe('2026-10-29');
    expect(window.endDate).toBe('2026-11-04');
    expect(window.dates).toEqual([
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
    expect(listCivilDateRange('2026-10-29', 7)).toEqual(window.dates);
    expect(addCivilDays('2026-10-29', 6)).toBe('2026-11-04');
  });

  it('defaults to every date in the window', () => {
    expect(
      eligibleCommuteOccurrenceDates({ publishingDate: '2026-10-29' }),
    ).toHaveLength(7);
  });

  it('skips excluded weekdays and normalizes duplicates', () => {
    expect(weekdayOfCivilDate('2026-10-29')).toBe(Weekday.THURSDAY);
    expect(weekdayOfCivilDate('2026-10-30')).toBe(Weekday.FRIDAY);
    const excluded = normalizeExcludedWeekdays([
      'FRIDAY',
      'friday',
      Weekday.SUNDAY,
    ]);
    expect(excluded).toEqual([Weekday.FRIDAY, Weekday.SUNDAY]);
    expect(
      eligibleCommuteOccurrenceDates({
        publishingDate: '2026-10-29',
        excludedWeekdays: ['FRIDAY', 'FRIDAY', 'SUNDAY'],
      }),
    ).toEqual([
      '2026-10-29',
      '2026-10-31',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });

  it('rejects invalid weekdays', () => {
    expect(() => normalizeExcludedWeekdays(['FUNDAY'])).toThrow(/Invalid weekday/);
  });

  it('requires return time strictly after outbound time', () => {
    expect(isReturnAfterOutbound('09:00:00', '18:30:00')).toBe(true);
    expect(isReturnAfterOutbound('18:30', '18:30:00')).toBe(false);
    expect(isReturnAfterOutbound('18:30:00', '09:00:00')).toBe(false);
  });

  it('treats recurring or returnEnabled as a series publish', () => {
    expect(isCommuteSeriesPublish({})).toBe(false);
    expect(isCommuteSeriesPublish({ recurring: true })).toBe(true);
    expect(isCommuteSeriesPublish({ returnEnabled: true })).toBe(true);
  });

  it('fingerprints are stable for the same payload', () => {
    const payload = { driverId: 'a', pricePerSeat: 100, excludeWeekdays: ['MONDAY'] };
    expect(commutePublishFingerprint(payload)).toBe(
      commutePublishFingerprint(payload),
    );
    expect(commutePublishFingerprint(payload)).not.toBe(
      commutePublishFingerprint({ ...payload, pricePerSeat: 101 }),
    );
  });
});
