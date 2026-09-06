import {
  isLikelyPemPrivateKey,
  normalizeFirebasePrivateKey,
  readFirebaseConfigPresence,
} from './firebase-config.util';

describe('firebase-config.util', () => {
  it('converts escaped newlines from single-line Render env values', () => {
    const raw =
      '-----BEGIN PRIVATE KEY-----\\nABC\\nDEF\\n-----END PRIVATE KEY-----\\n';
    const normalized = normalizeFirebasePrivateKey(raw);
    expect(normalized).toContain('\nABC\n');
    expect(normalized).not.toContain('\\n');
    expect(isLikelyPemPrivateKey(normalized)).toBe(true);
  });

  it('strips wrapping quotes commonly pasted from dashboards', () => {
    const raw =
      '"-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n"';
    const normalized = normalizeFirebasePrivateKey(raw);
    expect(normalized.startsWith('-----BEGIN')).toBe(true);
    expect(normalized.endsWith('-----')).toBe(true);
    expect(normalized.includes('"')).toBe(false);
  });

  it('preserves real multiline PEMs', () => {
    const raw = `-----BEGIN PRIVATE KEY-----
ABC
-----END PRIVATE KEY-----`;
    expect(normalizeFirebasePrivateKey(raw)).toBe(raw);
  });

  it('reports missing config presence without reading secrets', () => {
    expect(
      readFirebaseConfigPresence({
        projectId: 'p',
        clientEmail: '',
        privateKey: null,
      }),
    ).toEqual({
      projectIdConfigured: true,
      clientEmailConfigured: false,
      privateKeyConfigured: false,
    });
  });
});
