import {
  calculateAssuranceWindow,
  InvalidAssuranceWindowInputError,
} from './assured-window.math';

describe('calculateAssuranceWindow', () => {
  it('maps exact hour start to same-hour window', () => {
    const w = calculateAssuranceWindow('2026-08-30', '13:00:00');
    expect(w.windowStartTime).toBe('13:00:00');
    expect(w.windowEndTime).toBe('14:00:00');
    expect(w.windowId).toBe('13-14');
  });

  it('maps minute 00 within hour', () => {
    const w = calculateAssuranceWindow('2026-08-30', '13:00');
    expect(w.windowId).toBe('13-14');
  });

  it('maps mid-hour departure to floored window', () => {
    const w = calculateAssuranceWindow('2026-08-30', '13:15:00');
    expect(w.windowStartTime).toBe('13:00:00');
    expect(w.windowEndTime).toBe('14:00:00');
    expect(w.windowId).toBe('13-14');
  });

  it('maps minute 59 within hour', () => {
    const w = calculateAssuranceWindow('2026-08-30', '13:59:59');
    expect(w.windowId).toBe('13-14');
  });

  it('maps 17:45 to 17-18 window', () => {
    const w = calculateAssuranceWindow('2026-08-30', '17:45:00');
    expect(w.windowId).toBe('17-18');
  });

  it('maps midnight departure to 0-1 window', () => {
    const w = calculateAssuranceWindow('2026-08-30', '00:15:00');
    expect(w.windowStartTime).toBe('00:00:00');
    expect(w.windowEndTime).toBe('01:00:00');
    expect(w.windowId).toBe('0-1');
  });

  it('maps late-night departure to 23-0 window', () => {
    const w = calculateAssuranceWindow('2026-08-30', '23:30:00');
    expect(w.windowStartTime).toBe('23:00:00');
    expect(w.windowEndTime).toBe('00:00:00');
    expect(w.windowId).toBe('23-0');
  });

  it('accepts valid date boundaries', () => {
    expect(() =>
      calculateAssuranceWindow('2026-12-31', '23:59:00'),
    ).not.toThrow();
    expect(() =>
      calculateAssuranceWindow('2026-01-01', '00:00:00'),
    ).not.toThrow();
  });

  it('rejects invalid date', () => {
    expect(() => calculateAssuranceWindow('08-30-2026', '13:00')).toThrow(
      InvalidAssuranceWindowInputError,
    );
  });

  it('rejects invalid time', () => {
    expect(() =>
      calculateAssuranceWindow('2026-08-30', '25:00:00'),
    ).toThrow(InvalidAssuranceWindowInputError);
    expect(() =>
      calculateAssuranceWindow('2026-08-30', 'noon'),
    ).toThrow(InvalidAssuranceWindowInputError);
  });
});
