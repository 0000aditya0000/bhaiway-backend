import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';

import {
  CASHFREE_PRODUCTION_BASE_URL,
  CASHFREE_SANDBOX_BASE_URL,
  CashfreeConfigService,
  resolveCashfreeVerificationBaseUrl,
  resolveCashfreeVerificationEnvironment,
} from './cashfree.config';
import { CashfreeDigiLockerService } from './cashfree-digilocker.service';
import { CashfreeVehicleRcService } from './cashfree-vehicle-rc.service';

function generateTestRsaPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

describe('Cashfree verification environment URL selection', () => {
  describe('resolveCashfreeVerificationEnvironment', () => {
    it('accepts production (case-insensitive)', () => {
      expect(resolveCashfreeVerificationEnvironment('production')).toBe(
        'production',
      );
      expect(resolveCashfreeVerificationEnvironment('PRODUCTION')).toBe(
        'production',
      );
    });

    it('accepts sandbox (case-insensitive)', () => {
      expect(resolveCashfreeVerificationEnvironment('sandbox')).toBe('sandbox');
      expect(resolveCashfreeVerificationEnvironment('SANDBOX')).toBe('sandbox');
    });

    it('defaults missing env to production (never sandbox)', () => {
      expect(resolveCashfreeVerificationEnvironment(undefined)).toBe(
        'production',
      );
      expect(resolveCashfreeVerificationEnvironment('')).toBe('production');
    });

    it('fails fast on invalid env (no silent sandbox fallback)', () => {
      expect(() => resolveCashfreeVerificationEnvironment('prod')).toThrow(
        /Invalid CASHFREE_VERIFICATION_ENV/,
      );
      expect(() => resolveCashfreeVerificationEnvironment('live')).toThrow(
        /Invalid CASHFREE_VERIFICATION_ENV/,
      );
    });
  });

  describe('resolveCashfreeVerificationBaseUrl', () => {
    it('production → api.cashfree.com', () => {
      expect(resolveCashfreeVerificationBaseUrl('production')).toBe(
        'https://api.cashfree.com/verification',
      );
    });

    it('sandbox → sandbox.cashfree.com', () => {
      expect(resolveCashfreeVerificationBaseUrl('sandbox')).toBe(
        CASHFREE_SANDBOX_BASE_URL,
      );
    });
  });

  describe('CashfreeConfigService.getConfig', () => {
    function makeConfigService(env: Record<string, string>): ConfigService {
      return {
        get: (key: string) => env[key],
      } as unknown as ConfigService;
    }

    it('production config resolves DigiLocker production base URL', () => {
      const service = new CashfreeConfigService(
        makeConfigService({
          CASHFREE_VERIFICATION_ENV: 'production',
          CASHFREE_CLIENT_ID: 'cid',
          CASHFREE_CLIENT_SECRET: 'csecret',
          CASHFREE_DIGILOCKER_REDIRECT_URL:
            'https://bhaiway-backend.onrender.com/api/kyc/aadhaar/digilocker/callback',
        }),
      );
      const config = service.getConfig();
      expect(config.environment).toBe('production');
      expect(config.baseUrl).toBe(CASHFREE_PRODUCTION_BASE_URL);
      expect(config.publicKey).toBeNull();
    });

    it('sandbox config resolves DigiLocker sandbox base URL', () => {
      const service = new CashfreeConfigService(
        makeConfigService({
          CASHFREE_VERIFICATION_ENV: 'sandbox',
          CASHFREE_CLIENT_ID: 'cid',
          CASHFREE_CLIENT_SECRET: 'csecret',
        }),
      );
      const config = service.getConfig();
      expect(config.environment).toBe('sandbox');
      expect(config.baseUrl).toBe('https://sandbox.cashfree.com/verification');
    });

    it('loads CASHFREE_PUBLIC_KEY PEM for production 2FA', () => {
      const { publicKey } = generateTestRsaPair();
      const service = new CashfreeConfigService(
        makeConfigService({
          CASHFREE_VERIFICATION_ENV: 'production',
          CASHFREE_CLIENT_ID: 'cid',
          CASHFREE_CLIENT_SECRET: 'csecret',
          CASHFREE_PUBLIC_KEY: publicKey.replace(/\n/g, '\\n'),
        }),
      );
      const config = service.getConfig();
      expect(config.publicKey).toContain('BEGIN PUBLIC KEY');
    });
  });

  describe('outgoing Cashfree HTTP headers', () => {
    const secret = 'super-secret-value-should-never-appear-in-logs';
    const { publicKey } = generateTestRsaPair();

    afterEach(() => {
      jest.restoreAllMocks();
      delete process.env.CASHFREE_CF_SIGNATURE;
    });

    function makeConfig(overrides: Record<string, unknown> = {}) {
      return {
        environment: 'production' as const,
        baseUrl: CASHFREE_PRODUCTION_BASE_URL,
        clientId: 'test-client-id',
        clientSecret: secret,
        publicKey,
        redirectUrl:
          'https://bhaiway-backend.onrender.com/api/kyc/aadhaar/digilocker/callback',
        timeoutMs: 5000,
        ...overrides,
      };
    }

    it('DigiLocker production request includes x-client-id, x-client-secret, x-cf-signature', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          verification_id: 'vid_1',
          reference_id: 'ref_1',
          url: 'https://digilocker.example/auth',
          status: 'PENDING',
        }),
      } as Response);

      const service = new CashfreeDigiLockerService({
        getConfig: () => makeConfig(),
      } as unknown as CashfreeConfigService);

      await service.createVerificationUrl({ verificationId: 'vid_1' });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.cashfree.com/verification/digilocker',
        expect.objectContaining({ method: 'POST' }),
      );
      const headers = (fetchSpy.mock.calls[0][1] as RequestInit)
        .headers as Record<string, string>;
      expect(headers['x-client-id']).toBe('test-client-id');
      expect(headers['x-client-secret']).toBe(secret);
      expect(headers['x-cf-signature']).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(headers['x-cf-signature']).not.toBe(process.env.CASHFREE_CF_SIGNATURE);
    });

    it('Vehicle RC production request includes x-client-id, x-client-secret, x-cf-signature', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'VALID',
          verification_id: 'rc_1',
          reg_no: 'DL01AB1234',
        }),
      } as Response);

      const service = new CashfreeVehicleRcService({
        getConfig: () => makeConfig(),
      } as unknown as CashfreeConfigService);

      await service.verifyVehicleRc({
        verificationId: 'rc_1',
        vehicleNumber: 'DL01AB1234',
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.cashfree.com/verification/vehicle-rc',
        expect.objectContaining({ method: 'POST' }),
      );
      const headers = (fetchSpy.mock.calls[0][1] as RequestInit)
        .headers as Record<string, string>;
      expect(headers['x-client-id']).toBe('test-client-id');
      expect(headers['x-client-secret']).toBe(secret);
      expect(headers['x-cf-signature']).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    });

    it('does not send a static CASHFREE_CF_SIGNATURE', async () => {
      process.env.CASHFREE_CF_SIGNATURE = 'this-static-value-must-not-be-sent';
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          verification_id: 'vid_static',
          reference_id: 'ref_static',
          url: 'https://digilocker.example/auth',
          status: 'PENDING',
        }),
      } as Response);

      const service = new CashfreeDigiLockerService({
        getConfig: () => makeConfig(),
      } as unknown as CashfreeConfigService);

      await service.createVerificationUrl({ verificationId: 'vid_static' });
      const headers = (fetchSpy.mock.calls[0][1] as RequestInit)
        .headers as Record<string, string>;
      expect(headers['x-cf-signature']).toBeDefined();
      expect(headers['x-cf-signature']).not.toBe(
        'this-static-value-must-not-be-sent',
      );
    });

    it('sandbox DigiLocker omits x-cf-signature and uses the sandbox URL', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          verification_id: 'vid_sb',
          reference_id: 'ref_sb',
          url: 'https://digilocker.example/auth',
          status: 'PENDING',
        }),
      } as Response);

      const service = new CashfreeDigiLockerService({
        getConfig: () =>
          makeConfig({
            environment: 'sandbox',
            baseUrl: CASHFREE_SANDBOX_BASE_URL,
            publicKey: null,
          }),
      } as unknown as CashfreeConfigService);

      await service.createVerificationUrl({ verificationId: 'vid_sb' });
      expect(fetchSpy.mock.calls[0][0]).toBe(
        'https://sandbox.cashfree.com/verification/digilocker',
      );
      const headers = (fetchSpy.mock.calls[0][1] as RequestInit)
        .headers as Record<string, string>;
      expect(headers['x-cf-signature']).toBeUndefined();
      expect(headers['x-client-id']).toBe('test-client-id');
    });
  });
});
