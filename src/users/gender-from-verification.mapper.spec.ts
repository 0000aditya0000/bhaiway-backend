import { Gender } from './entities/user-profile.entity';
import { mapVerifiedGenderToEnum } from './gender-from-verification.mapper';

describe('mapVerifiedGenderToEnum', () => {
  it('maps Aadhaar female codes', () => {
    expect(mapVerifiedGenderToEnum('F')).toBe(Gender.FEMALE);
    expect(mapVerifiedGenderToEnum('female')).toBe(Gender.FEMALE);
    expect(mapVerifiedGenderToEnum('FEMALE')).toBe(Gender.FEMALE);
  });

  it('maps Aadhaar male codes', () => {
    expect(mapVerifiedGenderToEnum('M')).toBe(Gender.MALE);
    expect(mapVerifiedGenderToEnum('Male')).toBe(Gender.MALE);
  });

  it('maps other codes', () => {
    expect(mapVerifiedGenderToEnum('O')).toBe(Gender.OTHER);
    expect(mapVerifiedGenderToEnum('TRANSGENDER')).toBe(Gender.OTHER);
  });

  it('returns null for unknown values', () => {
    expect(mapVerifiedGenderToEnum(null)).toBeNull();
    expect(mapVerifiedGenderToEnum('')).toBeNull();
    expect(mapVerifiedGenderToEnum('X')).toBeNull();
  });
});
