import { ConfigService } from '@nestjs/config';

import {
  CASHFREE_PRODUCTION_BASE_URL,
  CashfreeConfigService,
} from './cashfree.config';
import { CashfreeDigiLockerService } from './cashfree-digilocker.service';

describe('Cashfree production-only verification config', () => {
  describe('CashfreeConfigService.getConfig', () => {
    function makeConfigService(env: Record<string, string>): ConfigService {
      return {
        get: (key: string) => env[key],
      } as unknown as ConfigService;
    }

    it('always resolves DigiLocker production base URL', () => {
      const service = new CashfreeConfigService(
        makeConfigService({
          CASHFREE_CLIENT_ID: 'cid',
          CASHFREE_CLIENT_SECRET: 'csecret',
          CASHFREE_DIGILOCKER_REDIRECT_URL:
            'https://bhaiway-backend.onrender.com/api/kyc/aadhaar/digilocker/callback',
        }),
      );
      const config = service.getConfig();
      expect(config.environment).toBe('production');
      expect(config.baseUrl).toBe(CASHFREE_PRODUCTION_BASE_URL);
      expect(config.baseUrl).toBe('https://api.cashfree.com/verification');
      expect(config.redirectUrl).toBe(
        'https://bhaiway-backend.onrender.com/api/kyc/aadhaar/digilocker/callback',
      );
    });

    it('ignores legacy CASHFREE_VERIFICATION_ENV and still uses production', () => {
      const service = new CashfreeConfigService(
        makeConfigService({
          CASHFREE_VERIFICATION_ENV: 'sandbox',
          CASHFREE_CLIENT_ID: 'cid',
          CASHFREE_CLIENT_SECRET: 'csecret',
        }),
      );
      const config = service.getConfig();
      expect(config.environment).toBe('production');
      expect(config.baseUrl).toBe('https://api.cashfree.com/verification');
    });
  });

  describe('CashfreeDigiLockerService HTTP endpoints', () => {
    const secret = 'super-secret-value-should-never-appear-in-logs';

    function makeDigiLockerService() {
      const configService = {
        getConfig: () => ({
          environment: 'production' as const,
          baseUrl: CASHFREE_PRODUCTION_BASE_URL,
          clientId: 'test-client-id',
          clientSecret: secret,
          redirectUrl:
            'https://bhaiway-backend.onrender.com/api/kyc/aadhaar/digilocker/callback',
          timeoutMs: 5000,
        }),
      } as unknown as CashfreeConfigService;
      return new CashfreeDigiLockerService(configService);
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('create uses https://api.cashfree.com/verification/digilocker', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          verification_id: 'vid_1',
          reference_id: 'ref_1',
          url: 'https://digilocker.example/auth',
          status: 'PENDING',
        }),
      } as Response);

      const service = makeDigiLockerService();
      await service.createVerificationUrl({ verificationId: 'vid_1' });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.cashfree.com/verification/digilocker',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('status uses https://api.cashfree.com/verification/digilocker', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'PENDING', verification_id: 'vid_3' }),
      } as Response);

      const service = makeDigiLockerService();
      await service.getVerificationStatus({ verificationId: 'vid_3' });

      expect(fetchSpy.mock.calls[0][0]).toBe(
        'https://api.cashfree.com/verification/digilocker?verification_id=vid_3',
      );
    });

    it('document uses .../digilocker/document/AADHAAR', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'VALID', name: 'Test User' }),
      } as Response);

      const service = makeDigiLockerService();
      await service.getAadhaarDocument({ verificationId: 'vid_4' });

      expect(fetchSpy.mock.calls[0][0]).toBe(
        'https://api.cashfree.com/verification/digilocker/document/AADHAAR?verification_id=vid_4',
      );
    });

    it('credentials are sent in headers but never appear in logs', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          verification_id: 'vid_6',
          reference_id: 'ref_6',
          url: 'https://digilocker.example/auth',
          status: 'PENDING',
        }),
      } as Response);

      const service = makeDigiLockerService();
      await service.createVerificationUrl({ verificationId: 'vid_6' });

      const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(fetchCall[1].headers['x-client-id']).toBe('test-client-id');
      expect(fetchCall[1].headers['x-client-secret']).toBe(secret);

      const allLogText = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map(String)
        .join('\n');
      expect(allLogText).not.toContain(secret);

      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });
});
