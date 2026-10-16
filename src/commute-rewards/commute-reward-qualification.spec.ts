import {
  BookingMode,
  BookingPickupStatus,
  BookingStatus,
} from '../bookings/enums/booking.enums';
import {
  countDistinctQualifyingPassengers,
  isQualifyingCompletedPassenger,
  MIN_QUALIFYING_PASSENGERS,
} from './commute-reward-qualification';

describe('commute-reward-qualification', () => {
  it('requires COMPLETED + PICKED_UP commute bookings', () => {
    expect(
      isQualifyingCompletedPassenger({
        passengerId: 'a',
        status: BookingStatus.COMPLETED,
        bookingMode: BookingMode.COMMUTE,
        pickupStatus: BookingPickupStatus.PICKED_UP,
      }),
    ).toBe(true);

    expect(
      isQualifyingCompletedPassenger({
        passengerId: 'a',
        status: BookingStatus.CONFIRMED,
        bookingMode: BookingMode.COMMUTE,
        pickupStatus: BookingPickupStatus.PICKED_UP,
      }),
    ).toBe(false);

    expect(
      isQualifyingCompletedPassenger({
        passengerId: 'a',
        status: BookingStatus.COMPLETED,
        bookingMode: BookingMode.COMMUTE,
        pickupStatus: BookingPickupStatus.WAITING_FOR_PICKUP,
      }),
    ).toBe(false);

    expect(
      isQualifyingCompletedPassenger({
        passengerId: 'a',
        status: BookingStatus.COMPLETED,
        bookingMode: BookingMode.REGULAR,
        pickupStatus: BookingPickupStatus.PICKED_UP,
      }),
    ).toBe(false);
  });

  it('counts distinct passengers once even with duplicate rows', () => {
    const bookings = [
      {
        passengerId: 'p1',
        status: BookingStatus.COMPLETED,
        bookingMode: BookingMode.COMMUTE,
        pickupStatus: BookingPickupStatus.PICKED_UP,
      },
      {
        passengerId: 'p1',
        status: BookingStatus.COMPLETED,
        bookingMode: BookingMode.COMMUTE,
        pickupStatus: BookingPickupStatus.PICKED_UP,
      },
      {
        passengerId: 'p2',
        status: BookingStatus.COMPLETED,
        bookingMode: BookingMode.COMMUTE,
        pickupStatus: BookingPickupStatus.PICKED_UP,
      },
      {
        passengerId: 'p3',
        status: BookingStatus.COMPLETED,
        bookingMode: BookingMode.COMMUTE,
        pickupStatus: BookingPickupStatus.PICKED_UP,
      },
    ];
    expect(countDistinctQualifyingPassengers(bookings)).toBe(3);
    expect(MIN_QUALIFYING_PASSENGERS).toBe(2);
  });

  it('empty and single-passenger sets fall below threshold', () => {
    expect(countDistinctQualifyingPassengers([])).toBe(0);
    expect(
      countDistinctQualifyingPassengers([
        {
          passengerId: 'only',
          status: BookingStatus.COMPLETED,
          bookingMode: BookingMode.COMMUTE,
          pickupStatus: BookingPickupStatus.PICKED_UP,
        },
      ]),
    ).toBe(1);
  });
});
