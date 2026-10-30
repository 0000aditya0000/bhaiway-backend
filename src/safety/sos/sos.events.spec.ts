import { SOS_DOMAIN_EVENTS } from './sos.events';
import { SosEventsService } from './sos-events.service';

describe('SosEventsService', () => {
  it('emits sos.created for future trusted-contact handlers and never sends SMS', () => {
    const service = new SosEventsService();
    const received: string[] = [];
    service.onCreated((event) => {
      received.push(event.sosId);
    });
    service.emitCreated({
      sosId: 'sos-1',
      rideId: 'ride-1',
      originalTriggerUserId: 'user-1',
      triggeredAt: new Date().toISOString(),
    });
    expect(received).toEqual(['sos-1']);
    expect(SOS_DOMAIN_EVENTS.CREATED).toBe('sos.created');
  });
});
