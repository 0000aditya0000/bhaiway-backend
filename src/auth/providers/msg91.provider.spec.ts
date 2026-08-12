import { ConfigService } from '@nestjs/config';

import {
  Msg91InvalidAccessTokenError,
  Msg91ResponseFormatError,
  Msg91UnavailableError,
  Msg91VerificationFailedError,
} from '../errors/msg91.errors';
import { Msg91OtpProvider } from './msg91.provider';

describe('Msg91OtpProvider', () => {
  const originalFetch = global.fetch;
  let provider: Msg91OtpProvider;
  let configValues: Record<string, string | undefined>;

  beforeEach(() => {
    configValues = {
      MSG91_AUTHKEY: 'test-authkey',
    };

    const configService = {
      get: (key: string) => configValues[key],
    } as ConfigService;

    provider = new Msg91OtpProvider(configService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('rejects an empty access token', async () => {
    await expect(provider.verifyAccessToken('')).rejects.toBeInstanceOf(
      Msg91InvalidAccessTokenError,
    );
    await expect(provider.verifyAccessToken('   ')).rejects.toBeInstanceOf(
      Msg91InvalidAccessTokenError,
    );
  });

  it('calls api.msg91.com with authkey header and access-token body', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ type: 'success', message: '919999999999' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.verifyAccessToken('msg91-access-token');

    expect(result).toEqual({
      phone: '919999999999',
      verified: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.msg91.com/api/v5/widget/verifyAccessToken');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.authkey).toBe('test-authkey');

    const body = JSON.parse(init.body as string);
    expect(body['access-token']).toBe('msg91-access-token');
    expect(body.authkey).toBeUndefined();
  });

  it('maps success message to verified phone without inventing other fields', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        type: 'success',
        message: '919999999999',
        phone: 'should-be-ignored',
        mobile: 'should-be-ignored',
        data: { phone: 'should-be-ignored' },
      }),
    }) as unknown as typeof fetch;

    const result = await provider.verifyAccessToken('token');
    expect(result.phone).toBe('919999999999');
    expect(result.verified).toBe(true);
  });

  it('rejects non-success MSG91 responses', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ type: 'error', message: 'invalid token' }),
    }) as unknown as typeof fetch;

    await expect(
      provider.verifyAccessToken('bad-token'),
    ).rejects.toBeInstanceOf(Msg91VerificationFailedError);
  });

  it('rejects success responses without a string phone message', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ type: 'success', message: { phone: '919999999999' } }),
    }) as unknown as typeof fetch;

    await expect(provider.verifyAccessToken('token')).rejects.toBeInstanceOf(
      Msg91ResponseFormatError,
    );
  });

  it('does not log MSG91 authkey or access token', async () => {
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ type: 'success', message: '919999999999' }),
    }) as unknown as typeof fetch;

    await provider.verifyAccessToken('super-secret-access-token');

    const combined = [
      ...errorSpy.mock.calls,
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
    ]
      .flat()
      .map(String)
      .join(' ');

    expect(combined).not.toContain('test-authkey');
    expect(combined).not.toContain('super-secret-access-token');
  });

  it('handles MSG91 HTTP failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ type: 'error' }),
    }) as unknown as typeof fetch;

    await expect(
      provider.verifyAccessToken('bad-token'),
    ).rejects.toBeInstanceOf(Msg91VerificationFailedError);
  });

  it('handles network failure', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    await expect(
      provider.verifyAccessToken('any-token'),
    ).rejects.toBeInstanceOf(Msg91UnavailableError);
  });

  it('fails when MSG91_AUTHKEY is missing', async () => {
    configValues.MSG91_AUTHKEY = undefined;
    await expect(
      provider.verifyAccessToken('token'),
    ).rejects.toBeInstanceOf(Msg91UnavailableError);
  });
});
