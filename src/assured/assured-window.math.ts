/**
 * 1-hour Assurance Window derived from civil departure date/time.
 *
 * Independent from half-time ({@link calculateAssuredHalfTime} in assured-timing.ts).
 * Examples: 13:15 → 13:00–14:00, 17:45 → 17:00–18:00.
 */

export interface AssuranceWindow {
  /** Civil wall-clock start (HH:mm:ss). */
  windowStartTime: string;
  /** Civil wall-clock end (HH:mm:ss); 00:00:00 means end of hour 23. */
  windowEndTime: string;
  /** Start hour 0–23. */
  windowStartHour: number;
  /** End hour 0–23 (may be 0 when window is 23:00–00:00). */
  windowEndHour: number;
  /** Deterministic bucket id, e.g. "13-14" or "23-0". */
  windowId: string;
}

const TIME_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class InvalidAssuranceWindowInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAssuranceWindowInputError';
  }
}

function normalizeDepartureTime(departureTime: string): string {
  const trimmed = departureTime.trim();
  const match = TIME_PATTERN.exec(trimmed);
  if (!match) {
    throw new InvalidAssuranceWindowInputError(
      `Invalid departure time: ${departureTime}`,
    );
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    throw new InvalidAssuranceWindowInputError(
      `Invalid departure time components: ${departureTime}`,
    );
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function assertDepartureDate(departureDate: string): void {
  if (!DATE_PATTERN.test(departureDate.trim())) {
    throw new InvalidAssuranceWindowInputError(
      `Invalid departure date: ${departureDate}`,
    );
  }
}

function formatHourTime(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00:00`;
}

/**
 * Floor departure time to the containing 1-hour assurance window.
 */
export function calculateAssuranceWindow(
  departureDate: string,
  departureTime: string,
): AssuranceWindow {
  assertDepartureDate(departureDate);
  const normalized = normalizeDepartureTime(departureTime);
  const hour = Number(normalized.slice(0, 2));
  const windowStartHour = hour;
  const windowEndHour = (hour + 1) % 24;

  return {
    windowStartTime: formatHourTime(windowStartHour),
    windowEndTime: formatHourTime(windowEndHour),
    windowStartHour,
    windowEndHour,
    windowId: `${windowStartHour}-${windowEndHour}`,
  };
}
