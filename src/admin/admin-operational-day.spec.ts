import {
  getAsiaKolkataOperationalDay,
  ADMIN_DASHBOARD_TIMEZONE,
} from './admin-operational-day';

describe('getAsiaKolkataOperationalDay', () => {
  it('returns Asia/Kolkata timezone label', () => {
    const window = getAsiaKolkataOperationalDay(
      new Date('2026-03-20T12:00:00.000Z'),
    );
    expect(window.timezone).toBe(ADMIN_DASHBOARD_TIMEZONE);
    expect(window.timezone).toBe('Asia/Kolkata');
  });

  it('uses [start, end) spanning exactly one IST civil day', () => {
    // 2026-03-20 18:30 UTC = 2026-03-21 00:00 IST
    const justAfterMidnightIst = new Date('2026-03-20T18:30:00.000Z');
    const window = getAsiaKolkataOperationalDay(justAfterMidnightIst);

    expect(window.start.toISOString()).toBe('2026-03-20T18:30:00.000Z');
    expect(window.end.toISOString()).toBe('2026-03-21T18:30:00.000Z');
    expect(window.end.getTime() - window.start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('places late-evening IST still on the same civil day', () => {
    // 2026-03-21 18:29 UTC = 2026-03-21 23:59 IST
    const lateIst = new Date('2026-03-21T18:29:00.000Z');
    const window = getAsiaKolkataOperationalDay(lateIst);
    expect(window.start.toISOString()).toBe('2026-03-20T18:30:00.000Z');
    expect(window.end.toISOString()).toBe('2026-03-21T18:30:00.000Z');
    expect(lateIst.getTime()).toBeGreaterThanOrEqual(window.start.getTime());
    expect(lateIst.getTime()).toBeLessThan(window.end.getTime());
  });

  it('does not use server-local CURRENT_DATE semantics', () => {
    const noonUtc = new Date('2026-06-15T12:00:00.000Z');
    const window = getAsiaKolkataOperationalDay(noonUtc);
    // Noon UTC = 17:30 IST on 2026-06-15 → IST day starts 2026-06-14T18:30:00.000Z
    expect(window.startIso).toBe('2026-06-14T18:30:00.000Z');
    expect(window.endIso).toBe('2026-06-15T18:30:00.000Z');
    expect(noonUtc.getTime()).toBeGreaterThanOrEqual(window.start.getTime());
    expect(noonUtc.getTime()).toBeLessThan(window.end.getTime());
  });
});
