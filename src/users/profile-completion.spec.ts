import { isProfileCompleted } from './profile-completion';

describe('isProfileCompleted', () => {
  it('is false when profile is missing', () => {
    expect(isProfileCompleted(null)).toBe(false);
    expect(isProfileCompleted(undefined)).toBe(false);
  });

  it('is false when firstName is empty', () => {
    expect(isProfileCompleted({ firstName: '' })).toBe(false);
    expect(isProfileCompleted({ firstName: '   ' })).toBe(false);
  });

  it('is true when firstName is present', () => {
    expect(isProfileCompleted({ firstName: 'Ada' })).toBe(true);
  });
});
