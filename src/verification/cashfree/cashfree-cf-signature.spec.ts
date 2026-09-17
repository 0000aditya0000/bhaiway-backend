import * as crypto from 'crypto';

import {
  buildCashfreeSignaturePlaintext,
  buildCashfreeVerificationHeaders,
  CASHFREE_CF_SIGNATURE_OAEP_HASH,
  generateCashfreeCfSignature,
} from './cashfree-cf-signature';

function generateTestRsaPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function decryptCashfreeSignature(
  signature: string,
  privateKeyPem: string,
): string {
  return crypto
    .privateDecrypt(
      {
        key: privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: CASHFREE_CF_SIGNATURE_OAEP_HASH,
      },
      Buffer.from(signature, 'base64'),
    )
    .toString('utf8');
}

describe('generateCashfreeCfSignature', () => {
  const { publicKey, privateKey } = generateTestRsaPair();
  const clientId = 'cf_test_client_id';
  const clientSecret = 'super-secret-must-never-be-in-plaintext';

  it('1. encrypts clientId.timestamp plaintext', () => {
    const nowSeconds = 1_700_000_000;
    const signature = generateCashfreeCfSignature({
      clientId,
      publicKeyPem: publicKey,
      nowSeconds,
    });
    const plaintext = decryptCashfreeSignature(signature, privateKey);
    expect(plaintext).toBe(`${clientId}.${nowSeconds}`);
    expect(buildCashfreeSignaturePlaintext(clientId, nowSeconds).plaintext).toBe(
      `${clientId}.${nowSeconds}`,
    );
  });

  it('2. uses the current Unix timestamp in seconds', () => {
    const before = Math.floor(Date.now() / 1000);
    const signature = generateCashfreeCfSignature({
      clientId,
      publicKeyPem: publicKey,
    });
    const after = Math.floor(Date.now() / 1000);
    const plaintext = decryptCashfreeSignature(signature, privateKey);
    const timestamp = Number(plaintext.split('.')[1]);
    expect(plaintext.startsWith(`${clientId}.`)).toBe(true);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('3. returns Base64-encoded ciphertext', () => {
    const signature = generateCashfreeCfSignature({
      clientId,
      publicKeyPem: publicKey,
      nowSeconds: 1_700_000_001,
    });
    expect(signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(() => Buffer.from(signature, 'base64')).not.toThrow();
    expect(Buffer.from(signature, 'base64').length).toBeGreaterThan(0);
  });

  it('4. changes when the timestamp changes', () => {
    const first = generateCashfreeCfSignature({
      clientId,
      publicKeyPem: publicKey,
      nowSeconds: 1_700_000_010,
    });
    const second = generateCashfreeCfSignature({
      clientId,
      publicKeyPem: publicKey,
      nowSeconds: 1_700_000_011,
    });
    expect(first).not.toBe(second);
    expect(decryptCashfreeSignature(first, privateKey)).toBe(
      `${clientId}.1700000010`,
    );
    expect(decryptCashfreeSignature(second, privateKey)).toBe(
      `${clientId}.1700000011`,
    );
  });

  it('5. can be generated repeatedly', () => {
    const signatures = Array.from({ length: 3 }, () =>
      generateCashfreeCfSignature({
        clientId,
        publicKeyPem: publicKey,
        nowSeconds: 1_700_000_020,
      }),
    );
    for (const signature of signatures) {
      expect(decryptCashfreeSignature(signature, privateKey)).toBe(
        `${clientId}.1700000020`,
      );
    }
  });

  it('6. never includes the client secret in the signature plaintext', () => {
    const signature = generateCashfreeCfSignature({
      clientId,
      publicKeyPem: publicKey,
      nowSeconds: 1_700_000_030,
    });
    const plaintext = decryptCashfreeSignature(signature, privateKey);
    expect(plaintext).not.toContain(clientSecret);
    expect(plaintext).toBe(`${clientId}.1700000030`);
  });

  it('7. uses RSA OAEP SHA-1 (Cashfree RSA/ECB/OAEPWithSHA-1AndMGF1Padding)', () => {
    const signature = generateCashfreeCfSignature({
      clientId,
      publicKeyPem: publicKey,
      nowSeconds: 1_700_000_040,
    });

    expect(CASHFREE_CF_SIGNATURE_OAEP_HASH).toBe('sha1');
    expect(
      decryptCashfreeSignature(signature, privateKey),
    ).toBe(`${clientId}.1700000040`);

    expect(() =>
      crypto.privateDecrypt(
        {
          key: privateKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        Buffer.from(signature, 'base64'),
      ),
    ).toThrow();
  });

  it('does not use a static CASHFREE_CF_SIGNATURE value', () => {
    const first = generateCashfreeCfSignature({
      clientId,
      publicKeyPem: publicKey,
      nowSeconds: 1_700_000_050,
    });
    const second = generateCashfreeCfSignature({
      clientId,
      publicKeyPem: publicKey,
      nowSeconds: 1_700_000_051,
    });
    expect(first).not.toBe('static-signature');
    expect(first).not.toBe(second);
  });
});

describe('buildCashfreeVerificationHeaders', () => {
  const { publicKey } = generateTestRsaPair();

  it('production includes x-client-id, x-client-secret, and a dynamic x-cf-signature', () => {
    const headers = buildCashfreeVerificationHeaders({
      environment: 'production',
      clientId: 'prod-client',
      clientSecret: 'prod-secret',
      publicKey,
    });
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['x-client-id']).toBe('prod-client');
    expect(headers['x-client-secret']).toBe('prod-secret');
    expect(headers['x-cf-signature']).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(headers['x-cf-signature']).not.toBe('prod-secret');
  });

  it('sandbox omits x-cf-signature even when a public key is present', () => {
    const headers = buildCashfreeVerificationHeaders({
      environment: 'sandbox',
      clientId: 'sb-client',
      clientSecret: 'sb-secret',
      publicKey,
    });
    expect(headers['x-client-id']).toBe('sb-client');
    expect(headers['x-client-secret']).toBe('sb-secret');
    expect(headers['x-cf-signature']).toBeUndefined();
  });
});
