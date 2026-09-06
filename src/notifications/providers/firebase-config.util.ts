/**
 * Normalize a Firebase service-account private key from environment variables.
 *
 * Render / Docker often store PEM as a single line with escaped `\n`, sometimes
 * wrapped in quotes. Never log the returned value.
 */
export function normalizeFirebasePrivateKey(raw: string): string {
  let key = raw.trim();

  // Strip wrapping single/double quotes from dashboard paste.
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }

  // Convert escaped newlines (and Windows variants) to real newlines.
  key = key.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n');

  return key.trim();
}

export function isLikelyPemPrivateKey(key: string): boolean {
  return (
    key.includes('BEGIN PRIVATE KEY') ||
    key.includes('BEGIN RSA PRIVATE KEY')
  );
}

export type FirebaseConfigPresence = {
  projectIdConfigured: boolean;
  clientEmailConfigured: boolean;
  privateKeyConfigured: boolean;
};

export function readFirebaseConfigPresence(env: {
  projectId?: string | null;
  clientEmail?: string | null;
  privateKey?: string | null;
}): FirebaseConfigPresence {
  return {
    projectIdConfigured: Boolean(env.projectId?.trim()),
    clientEmailConfigured: Boolean(env.clientEmail?.trim()),
    privateKeyConfigured: Boolean(env.privateKey?.trim()),
  };
}
