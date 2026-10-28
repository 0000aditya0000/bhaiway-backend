import { createHash } from 'crypto';

import { addCivilDays, listCivilDateRange } from '../common/time/ride-timezone';
import { Weekday } from './enums/ride.enums';

export const COMMUTE_RECURRENCE_WINDOW_DAYS = 7;

const WEEKDAYS_BY_UTC_DAY: readonly Weekday[] = [
  Weekday.SUNDAY,
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY,
  Weekday.SATURDAY,
];

export function normalizeExcludedWeekdays(
  values: readonly string[] | null | undefined,
): Weekday[] {
  if (!values?.length) {
    return [];
  }
  const allowed = new Set<string>(Object.values(Weekday));
  const seen = new Set<Weekday>();
  const result: Weekday[] = [];
  for (const raw of values) {
    const value = String(raw ?? '').trim().toUpperCase();
    if (!allowed.has(value)) {
      throw new Error(`Invalid weekday: ${raw}`);
    }
    const weekday = value as Weekday;
    if (!seen.has(weekday)) {
      seen.add(weekday);
      result.push(weekday);
    }
  }
  const order = new Map(Object.values(Weekday).map((day, index) => [day, index]));
  result.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
  return result;
}

/** Weekday of a civil YYYY-MM-DD date (calendar arithmetic, timezone-independent). */
export function weekdayOfCivilDate(departureDate: string): Weekday {
  const [year, month, day] = departureDate.split('-').map(Number);
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return WEEKDAYS_BY_UTC_DAY[jsDay] ?? Weekday.SUNDAY;
}

export function commuteRecurrenceWindow(
  publishingDate: string,
): { startDate: string; endDate: string; dates: string[] } {
  const dates = listCivilDateRange(
    publishingDate,
    COMMUTE_RECURRENCE_WINDOW_DAYS,
  );
  return {
    startDate: publishingDate,
    endDate: addCivilDays(publishingDate, COMMUTE_RECURRENCE_WINDOW_DAYS - 1),
    dates,
  };
}

export function eligibleCommuteOccurrenceDates(params: {
  publishingDate: string;
  excludedWeekdays?: readonly string[] | null;
}): string[] {
  const excluded = new Set(normalizeExcludedWeekdays(params.excludedWeekdays));
  const { dates } = commuteRecurrenceWindow(params.publishingDate);
  return dates.filter((date) => !excluded.has(weekdayOfCivilDate(date)));
}

export function civilTimeToSeconds(value: string): number {
  const normalized =
    value.length >= 8 ? value.slice(0, 8) : `${value}:00`.slice(0, 8);
  const [hour, minute, second] = normalized.split(':').map(Number);
  return hour * 3600 + minute * 60 + (second || 0);
}

export function isReturnAfterOutbound(
  outboundTime: string,
  returnTime: string,
): boolean {
  return civilTimeToSeconds(returnTime) > civilTimeToSeconds(outboundTime);
}

export function commutePublishFingerprint(fields: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(fields))
    .digest('hex');
}

export function isCommuteSeriesPublish(dto: {
  recurring?: boolean;
  returnEnabled?: boolean;
}): boolean {
  return dto.recurring === true || dto.returnEnabled === true;
}
