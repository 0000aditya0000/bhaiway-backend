import {
  buildAssuredQueueKey,
  buildRouteIdentity,
  calculateAssuredQueueIdentity,
} from './assured-queue-key';

describe('assured-queue-key', () => {
  const noidaDehradunCoords = {
    source: 'Noida',
    destination: 'Dehradun',
    sourceLatitude: 28.5355,
    sourceLongitude: 77.391,
    destinationLatitude: 30.3165,
    destinationLongitude: 78.0322,
  };

  it('uses coordinate identity when all endpoints present', () => {
    const id = buildRouteIdentity(noidaDehradunCoords);
    expect(id.startsWith('coord:')).toBe(true);
    expect(id).not.toContain('name:');
  });

  it('uses normalized names when coordinates absent', () => {
    const id = buildRouteIdentity({
      source: '  Noida ',
      destination: 'Dehradun',
    });
    expect(id).toBe('name:noida|dehradun');
  });

  it('different destinations produce different route identities', () => {
    const dehradun = buildRouteIdentity(noidaDehradunCoords);
    const haridwar = buildRouteIdentity({
      ...noidaDehradunCoords,
      destination: 'Haridwar',
      destinationLatitude: 29.9457,
      destinationLongitude: 78.1642,
    });
    expect(dehradun).not.toBe(haridwar);
  });

  it('same route + same date + same hour window share queue key', () => {
    const a = calculateAssuredQueueIdentity({
      ...noidaDehradunCoords,
      departureDate: '2026-08-30',
      departureTime: '13:15:00',
    });
    const b = calculateAssuredQueueIdentity({
      ...noidaDehradunCoords,
      departureDate: '2026-08-30',
      departureTime: '13:40:00',
    });
    expect(a.queueKey).toBe(b.queueKey);
    expect(a.windowId).toBe('13-14');
  });

  it('same route + same date + different hour window differ', () => {
    const morning = calculateAssuredQueueIdentity({
      ...noidaDehradunCoords,
      departureDate: '2026-08-30',
      departureTime: '13:15:00',
    });
    const evening = calculateAssuredQueueIdentity({
      ...noidaDehradunCoords,
      departureDate: '2026-08-30',
      departureTime: '17:10:00',
    });
    expect(morning.queueKey).not.toBe(evening.queueKey);
    expect(evening.windowId).toBe('17-18');
  });

  it('different route + same date + same hour differ', () => {
    const dehradun = calculateAssuredQueueIdentity({
      ...noidaDehradunCoords,
      departureDate: '2026-08-30',
      departureTime: '13:15:00',
    });
    const haridwar = calculateAssuredQueueIdentity({
      ...noidaDehradunCoords,
      destination: 'Haridwar',
      destinationLatitude: 29.9457,
      destinationLongitude: 78.1642,
      departureDate: '2026-08-30',
      departureTime: '13:15:00',
    });
    expect(dehradun.queueKey).not.toBe(haridwar.queueKey);
  });

  it('same route + different date differ', () => {
    const day1 = calculateAssuredQueueIdentity({
      ...noidaDehradunCoords,
      departureDate: '2026-08-30',
      departureTime: '13:15:00',
    });
    const day2 = calculateAssuredQueueIdentity({
      ...noidaDehradunCoords,
      departureDate: '2026-08-31',
      departureTime: '13:15:00',
    });
    expect(day1.queueKey).not.toBe(day2.queueKey);
  });

  it('buildAssuredQueueKey is deterministic', () => {
    const key = buildAssuredQueueKey({
      routeIdentity: 'coord:1:2:3:4',
      departureDate: '2026-08-30',
      windowId: '13-14',
    });
    expect(key).toBe('coord:1:2:3:4|2026-08-30|13-14');
  });
});
