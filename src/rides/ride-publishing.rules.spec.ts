import { isAtOrAfterDeparture } from '../assured/assured-timing';
import { RideStatus } from './enums/ride.enums';
import { RideDepartureInPastError } from './errors/ride-publishing.errors';
import {
  ACTIVE_ASSURED_RIDE_STATUSES,
  assertDepartureIsInFuture,
} from './ride-publishing.rules';
import {
  futureCivilDate,
  pastCivilDate,
} from './test/ride-departure-test.helpers';

describe('ride-publishing.rules', () => {
  it('exposes Assured active statuses used by the unique index', () => {
    expect([...ACTIVE_ASSURED_RIDE_STATUSES].sort()).toEqual(
      [
        RideStatus.ASSURANCE_ACTIVE,
        RideStatus.ASSURANCE_PENDING,
        RideStatus.IN_PROGRESS,
      ].sort(),
    );
  });

  it('rejects past and equal departures; allows future', () => {
    expect(() =>
      assertDepartureIsInFuture(pastCivilDate(1), '12:00:00'),
    ).toThrow(RideDepartureInPastError);

    const futureDate = futureCivilDate(3);
    expect(() =>
      assertDepartureIsInFuture(futureDate, '12:00:00'),
    ).not.toThrow();

    const now = new Date();
    expect(isAtOrAfterDeparture(now, pastCivilDate(1), '00:00:00')).toBe(true);
  });
});
