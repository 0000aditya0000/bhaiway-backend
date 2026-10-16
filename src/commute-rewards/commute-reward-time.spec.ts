import {
  addCalendarMonthsInTimeZone,
  isWithinWindow,
} from './commute-reward-time';

describe('commute-reward-time', () => {
  it('adds calendar months in Asia/Kolkata (not fixed 30-day blocks)', () => {
    // 2024-01-15 10:00 IST = 2024-01-15 04:30 UTC
    const start = new Date('2024-01-15T04:30:00.000Z');
    const end1 = addCalendarMonthsInTimeZone(start, 1, 'Asia/Kolkata');
    // 2024-02-15 10:00 IST
    expect(end1.toISOString()).toBe('2024-02-15T04:30:00.000Z');

    const end6 = addCalendarMonthsInTimeZone(start, 6, 'Asia/Kolkata');
    expect(end6.toISOString()).toBe('2024-07-15T04:30:00.000Z');

    const end12 = addCalendarMonthsInTimeZone(start, 12, 'Asia/Kolkata');
    expect(end12.toISOString()).toBe('2025-01-15T04:30:00.000Z');
  });

  it('clamps day overflow (Jan 31 + 1 month → Feb 29/28)', () => {
    const start = new Date('2024-01-31T04:30:00.000Z'); // 10:00 IST
    const end = addCalendarMonthsInTimeZone(start, 1, 'Asia/Kolkata');
    // 2024 is leap year → Feb 29 10:00 IST
    expect(end.toISOString()).toBe('2024-02-29T04:30:00.000Z');
  });

  it('isWithinWindow is half-open [start, end)', () => {
    const start = new Date('2024-01-01T00:00:00.000Z');
    const end = new Date('2024-02-01T00:00:00.000Z');
    expect(isWithinWindow(start, start, end)).toBe(true);
    expect(
      isWithinWindow(new Date('2024-01-31T23:59:59.000Z'), start, end),
    ).toBe(true);
    expect(isWithinWindow(end, start, end)).toBe(false);
  });
});
