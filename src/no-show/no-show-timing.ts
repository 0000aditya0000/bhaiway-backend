import { parseCivilDeparture } from '../assured/assured-timing';

import { NO_SHOW_ELIGIBLE_AFTER_MS } from './no-show.constants';

/**
 * True when `now` is at or after scheduled departure + 5 minutes
 * in the BhaiWay ride timezone (Asia/Kolkata).
 */
export function isNoShowEligible(
  now: Date,
  departureDate: string,
  departureTime: string,
): boolean {
  const eligibleAtMs =
    parseCivilDeparture(departureDate, departureTime).getTime() +
    NO_SHOW_ELIGIBLE_AFTER_MS;
  return now.getTime() >= eligibleAtMs;
}

export function noShowEligibleAt(
  departureDate: string,
  departureTime: string,
): Date {
  return new Date(
    parseCivilDeparture(departureDate, departureTime).getTime() +
      NO_SHOW_ELIGIBLE_AFTER_MS,
  );
}
