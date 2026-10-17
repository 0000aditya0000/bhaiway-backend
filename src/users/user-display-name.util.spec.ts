import { resolveUserDisplayName } from './user-display-name.util';

describe('resolveUserDisplayName', () => {
  it('prefers displayName', () => {
    expect(
      resolveUserDisplayName({
        displayName: 'Priya S',
        firstName: 'Priya',
        lastName: 'Sharma',
      }),
    ).toBe('Priya S');
  });

  it('falls back to first + last when displayName empty', () => {
    expect(
      resolveUserDisplayName({
        displayName: null,
        firstName: 'Amit',
        lastName: 'Kumar',
      }),
    ).toBe('Amit Kumar');
    expect(
      resolveUserDisplayName({
        displayName: '  ',
        firstName: 'Amit',
        lastName: null,
      }),
    ).toBe('Amit');
  });

  it('returns null when no name parts', () => {
    expect(resolveUserDisplayName(null)).toBeNull();
    expect(
      resolveUserDisplayName({
        displayName: null,
        firstName: '  ',
        lastName: null,
      }),
    ).toBeNull();
  });
});
