import { RideStatus } from '../rides/enums/ride.enums';
import {
  isAssuredBookableStatus,
  isAssuredSearchVisibleOffer,
  isAssuredSearchVisibleStatus,
  isAssuredStartableStatus,
  isRegularPublishedStatus,
} from './assured-ride-status';

describe('assured-ride-status passenger visibility', () => {
  it('E: regular published remains searchable', () => {
    expect(isRegularPublishedStatus(RideStatus.PUBLISHED)).toBe(true);
    expect(isRegularPublishedStatus(RideStatus.ASSURANCE_ACTIVE)).toBe(false);
  });

  it('B: ASSURANCE_PENDING is not search-visible', () => {
    expect(isAssuredSearchVisibleStatus(RideStatus.ASSURANCE_PENDING)).toBe(
      false,
    );
  });

  it('A: ASSURANCE_ACTIVE with seats is search-visible', () => {
    expect(isAssuredSearchVisibleStatus(RideStatus.ASSURANCE_ACTIVE)).toBe(
      true,
    );
    expect(
      isAssuredSearchVisibleOffer(RideStatus.ASSURANCE_ACTIVE, 3),
    ).toBe(true);
  });

  it('C: ASSURANCE_ACTIVE with zero seats is not a search offer', () => {
    expect(isAssuredSearchVisibleOffer(RideStatus.ASSURANCE_ACTIVE, 0)).toBe(
      false,
    );
  });

  it('D: PUBLISHED is not the Assured visibility gate', () => {
    expect(isAssuredSearchVisibleStatus(RideStatus.PUBLISHED)).toBe(false);
    expect(isAssuredSearchVisibleOffer(RideStatus.PUBLISHED, 3)).toBe(false);
  });

  it('ASSURANCE_ACTIVE is bookable', () => {
    expect(isAssuredBookableStatus(RideStatus.ASSURANCE_ACTIVE)).toBe(true);
  });

  it('ASSURANCE_PENDING and PUBLISHED are not Assured-bookable', () => {
    expect(isAssuredBookableStatus(RideStatus.ASSURANCE_PENDING)).toBe(false);
    expect(isAssuredBookableStatus(RideStatus.PUBLISHED)).toBe(false);
  });

  it('only ASSURANCE_ACTIVE Assured rides are startable', () => {
    expect(isAssuredStartableStatus(RideStatus.ASSURANCE_ACTIVE)).toBe(true);
    expect(isAssuredStartableStatus(RideStatus.ASSURANCE_PENDING)).toBe(false);
    expect(isAssuredStartableStatus(RideStatus.PUBLISHED)).toBe(false);
    expect(isAssuredStartableStatus(RideStatus.IN_PROGRESS)).toBe(false);
  });
});
