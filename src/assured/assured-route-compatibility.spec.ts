import {
  buildStraightRouteGeometry,
  encodePolyline,
} from '../rides/route/route-geometry';
import {
  buildAssuredQueueCoarseLockKeys,
  buildAssuredQueueDestinationBucket,
  isRideCompatibleWithGeographicQueue,
  sortQueueIdsForLocking,
} from './assured-route-compatibility';

const NOIDA = { latitude: 28.5355, longitude: 77.391 };
const INDIRAPURAM = { latitude: 28.6415, longitude: 77.372 };
const GURGAON = { latitude: 28.4595, longitude: 77.0266 };
const DEHRADUN = { latitude: 30.3165, longitude: 78.0322 };
const BAREILLY = { latitude: 28.367, longitude: 79.4304 };
const JAIPUR = { latitude: 26.9124, longitude: 75.7873 };
const MEERUT = { latitude: 28.9845, longitude: 77.7064 };

const CORRIDOR_METERS = 50_000;

function queueFromRoute(
  source: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number },
  corridorRadiusMeters = CORRIDOR_METERS,
) {
  const geometry = buildStraightRouteGeometry(source, destination);
  return {
    canonicalPolyline: geometry.polylineEncoded,
    anchorDestinationLatitude: destination.latitude,
    anchorDestinationLongitude: destination.longitude,
    corridorRadiusMeters,
  };
}

function rideCandidate(
  source: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number },
) {
  const geometry = buildStraightRouteGeometry(source, destination);
  return {
    sourceLatitude: source.latitude,
    sourceLongitude: source.longitude,
    destinationLatitude: destination.latitude,
    destinationLongitude: destination.longitude,
    routePolyline: geometry.polylineEncoded,
  };
}

describe('assured-route-compatibility', () => {
  const noidaDehradunQueue = queueFromRoute(NOIDA, DEHRADUN);

  it('1: Noida → Dehradun + Indirapuram → Dehradun share queue', () => {
    expect(
      isRideCompatibleWithGeographicQueue(
        rideCandidate(INDIRAPURAM, DEHRADUN),
        noidaDehradunQueue,
      ),
    ).toBe(true);
  });

  it('2: Gurgaon → Bareilly joins Noida → Bareilly queue when geometry matches', () => {
    const bareillyQueue = queueFromRoute(NOIDA, BAREILLY);
    expect(
      isRideCompatibleWithGeographicQueue(
        rideCandidate(GURGAON, BAREILLY),
        bareillyQueue,
      ),
    ).toBe(true);
  });

  it('3: Noida → Dehradun and Dehradun → Noida are different queues', () => {
    expect(
      isRideCompatibleWithGeographicQueue(
        rideCandidate(DEHRADUN, NOIDA),
        noidaDehradunQueue,
      ),
    ).toBe(false);
  });

  it('4: Noida → Dehradun and Noida → Jaipur are different queues', () => {
    expect(
      isRideCompatibleWithGeographicQueue(
        rideCandidate(NOIDA, JAIPUR),
        noidaDehradunQueue,
      ),
    ).toBe(false);
  });

  it('5: same route + same window conceptually compatible (geometry)', () => {
    expect(
      isRideCompatibleWithGeographicQueue(
        rideCandidate(NOIDA, DEHRADUN),
        noidaDehradunQueue,
      ),
    ).toBe(true);
  });

  it('8: nearby source but diverging destination rejected', () => {
    expect(
      isRideCompatibleWithGeographicQueue(
        rideCandidate(INDIRAPURAM, MEERUT),
        noidaDehradunQueue,
      ),
    ).toBe(false);
  });

  it('9: same highway segment but different final destination rejected by destination coherence', () => {
    const meerut = { latitude: 28.9845, longitude: 77.7064 };
    expect(
      isRideCompatibleWithGeographicQueue(
        rideCandidate(NOIDA, meerut),
        noidaDehradunQueue,
      ),
    ).toBe(false);
  });

  it('10: slight source variation within corridor remains compatible', () => {
    const noidaVariant = {
      latitude: NOIDA.latitude + 0.01,
      longitude: NOIDA.longitude + 0.01,
    };
    expect(
      isRideCompatibleWithGeographicQueue(
        rideCandidate(noidaVariant, DEHRADUN),
        noidaDehradunQueue,
      ),
    ).toBe(true);
  });

  it('27: reverse direction rejected', () => {
    expect(
      isRideCompatibleWithGeographicQueue(
        rideCandidate(DEHRADUN, NOIDA),
        noidaDehradunQueue,
      ),
    ).toBe(false);
  });

  it('destination bucket helper is stable', () => {
    expect(buildAssuredQueueDestinationBucket(30.3165, 78.0322)).toBe(
      '30.32:78.03',
    );
  });

  it('coarse lock keys are deterministic and sorted', () => {
    const a = buildAssuredQueueCoarseLockKeys({
      departureDate: '2026-08-30',
      windowId: '13-14',
      destinationLatitude: 30.3165,
      destinationLongitude: 78.0322,
    });
    const b = buildAssuredQueueCoarseLockKeys({
      departureDate: '2026-08-30',
      windowId: '13-14',
      destinationLatitude: 30.3165,
      destinationLongitude: 78.0322,
    });
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
    expect(a.length).toBe(9);
  });

  it('sortQueueIdsForLocking is lexicographic', () => {
    expect(
      sortQueueIdsForLocking([
        'b0000000-0000-0000-0000-000000000002',
        'a0000000-0000-0000-0000-000000000001',
      ]),
    ).toEqual([
      'a0000000-0000-0000-0000-000000000001',
      'b0000000-0000-0000-0000-000000000002',
    ]);
  });

  it('requires valid route polyline on candidate', () => {
    expect(
      isRideCompatibleWithGeographicQueue(
        {
          ...rideCandidate(NOIDA, DEHRADUN),
          routePolyline: '',
        },
        noidaDehradunQueue,
      ),
    ).toBe(false);
  });

  it('respects snapshotted queue corridor radius', () => {
    const tightQueue = queueFromRoute(NOIDA, DEHRADUN, 5_000);
    expect(
      isRideCompatibleWithGeographicQueue(
        rideCandidate(INDIRAPURAM, DEHRADUN),
        tightQueue,
      ),
    ).toBe(false);
  });

  it('decodes canonical polyline from queue', () => {
    const points = [NOIDA, DEHRADUN];
    const queue = {
      canonicalPolyline: encodePolyline(points),
      anchorDestinationLatitude: DEHRADUN.latitude,
      anchorDestinationLongitude: DEHRADUN.longitude,
      corridorRadiusMeters: CORRIDOR_METERS,
    };
    expect(
      isRideCompatibleWithGeographicQueue(rideCandidate(NOIDA, DEHRADUN), queue),
    ).toBe(true);
  });
});
