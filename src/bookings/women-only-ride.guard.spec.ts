import { RideType } from '../rides/enums/ride.enums';
import { Gender } from '../users/entities/user-profile.entity';
import { WomenOnlyRideError } from '../users/errors/gender.errors';
import { assertWomenOnlyBookingAllowed } from './women-only-ride.guard';

describe('assertWomenOnlyBookingAllowed', () => {
  it('allows any gender when womenOnly is false', () => {
    expect(() =>
      assertWomenOnlyBookingAllowed({
        rideType: RideType.REGULAR,
        womenOnly: false,
        passengerGender: Gender.MALE,
      }),
    ).not.toThrow();
  });

  it('allows FEMALE on womenOnly REGULAR', () => {
    expect(() =>
      assertWomenOnlyBookingAllowed({
        rideType: RideType.REGULAR,
        womenOnly: true,
        passengerGender: Gender.FEMALE,
      }),
    ).not.toThrow();
  });

  it('rejects MALE on womenOnly ASSURED', () => {
    expect(() =>
      assertWomenOnlyBookingAllowed({
        rideType: RideType.ASSURED,
        womenOnly: true,
        passengerGender: Gender.MALE,
      }),
    ).toThrow(WomenOnlyRideError);
  });

  it('rejects null gender on womenOnly ride', () => {
    expect(() =>
      assertWomenOnlyBookingAllowed({
        rideType: RideType.REGULAR,
        womenOnly: true,
        passengerGender: null,
      }),
    ).toThrow(WomenOnlyRideError);
  });

  it('does not enforce womenOnly on COMMUTE', () => {
    expect(() =>
      assertWomenOnlyBookingAllowed({
        rideType: RideType.COMMUTE,
        womenOnly: true,
        passengerGender: Gender.MALE,
      }),
    ).not.toThrow();
  });
});
