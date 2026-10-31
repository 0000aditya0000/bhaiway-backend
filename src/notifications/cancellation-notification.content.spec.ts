import {
  buildCancellationBody,
  formatCivilDate,
  formatRideRoute,
  humanizeCancellationActor,
  humanizeCancellationReason,
} from './cancellation-notification.content';

describe('cancellation notification content', () => {
  it('formats route, actor, reason and identifiers', () => {
    expect(formatRideRoute('Noida', 'Delhi')).toBe('Noida → Delhi');
    expect(formatCivilDate('2030-06-15')).toBe('15 Jun 2030');
    expect(humanizeCancellationActor('passenger')).toBe('The passenger');
    expect(humanizeCancellationReason('RIDER_CANCELLED')).toBe(
      'Passenger cancelled',
    );

    const body = buildCancellationBody({
      fallback: 'Your ride booking has been cancelled.',
      actor: 'passenger',
      snapshot: {
        source: 'Noida',
        destination: 'Delhi',
        departureDate: '2030-06-15',
        departureTime: '09:00:00',
      },
      cancellationReason: 'RIDER_CANCELLED',
      bookingId: 'booking-1',
      rideId: 'ride-1',
    });

    expect(body).toContain('Your ride booking has been cancelled.');
    expect(body).toContain('The passenger cancelled Noida → Delhi on 15 Jun 2030 at 09:00.');
    expect(body).toContain('Reason: Passenger cancelled.');
    expect(body).toContain('Booking ID: booking-1.');
    expect(body).toContain('Ride ID: ride-1.');
  });
});
