import * as crypto from 'crypto';

/**
 * Cashfree Secure ID Production 2FA (outgoing x-cf-signature).
 *
 * Official algorithm:
 *   plaintext = `${clientId}.${unixTimestampSeconds}`
 *   RSA encrypt with Cashfree public key using
 *   RSA/ECB/OAEPWithSHA-1AndMGF1Padding
 *   then Base64(encrypted bytes)
 *
 * Distinct from incoming webhook HMAC (`x-webhook-signature`).
 */
export const CASHFREE_CF_SIGNATURE_OAEP_HASH = 'sha1';

export function normalizeCashfreePublicKeyPem(raw: string): string {
  let key = raw.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }

  key = key
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .trim();

  if (
    key.includes('BEGIN PUBLIC KEY') ||
    key.includes('BEGIN RSA PUBLIC KEY')
  ) {
    return key;
  }

  const body = key.replace(/\s+/g, '');
  if (!body) {
    throw new Error('CASHFREE_PUBLIC_KEY is empty');
  }

  const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

export function buildCashfreeSignaturePlaintext(
  clientId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { plaintext: string; timestampSeconds: number } {
  if (!clientId) {
    throw new Error('CASHFREE_CLIENT_ID is required to generate x-cf-signature');
  }
  return {
    plaintext: `${clientId}.${nowSeconds}`,
    timestampSeconds: nowSeconds,
  };
}

export function generateCashfreeCfSignature(params: {
  clientId: string;
  publicKeyPem: string;
  nowSeconds?: number;
}): string {
  const { plaintext } = buildCashfreeSignaturePlaintext(
    params.clientId,
    params.nowSeconds,
  );
  const key = normalizeCashfreePublicKeyPem(params.publicKeyPem);

  const encrypted = crypto.publicEncrypt(
    {
      key,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: CASHFREE_CF_SIGNATURE_OAEP_HASH,
    },
    Buffer.from(plaintext, 'utf8'),
  );

  return encrypted.toString('base64');
}

export function buildCashfreeVerificationHeaders(config: {
  environment: 'production' | 'sandbox';
  clientId: string;
  clientSecret: string;
  publicKey?: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-client-id': config.clientId,
    'x-client-secret': config.clientSecret,
  };

  const publicKey = config.publicKey?.trim();
  if (config.environment === 'production' && publicKey) {
    headers['x-cf-signature'] = generateCashfreeCfSignature({
      clientId: config.clientId,
      publicKeyPem: publicKey,
    });
  }

  return headers;
}
