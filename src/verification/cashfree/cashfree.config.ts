import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { normalizeCashfreePublicKeyPem } from './cashfree-cf-signature';

export const CASHFREE_SANDBOX_BASE_URL =
  'https://sandbox.cashfree.com/verification';
export const CASHFREE_PRODUCTION_BASE_URL =
  'https://api.cashfree.com/verification';

export type CashfreeVerificationEnvironment = 'production' | 'sandbox';

export interface CashfreeDigiLockerConfig {
  environment: CashfreeVerificationEnvironment;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  publicKey: string | null;
  redirectUrl: string;
  timeoutMs: number;
}

function stripEnvQuotes(raw: string): string {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

/**
 * Normalize CASHFREE_VERIFICATION_ENV.
 * Missing/blank defaults to production (never sandbox).
 * Invalid values fail fast — they are not mapped to sandbox.
 */
export function resolveCashfreeVerificationEnvironment(
  raw: string | undefined | null,
): CashfreeVerificationEnvironment {
  if (raw == null || String(raw).trim() === '') {
    return 'production';
  }

  const value = stripEnvQuotes(String(raw)).toLowerCase();
  if (value === 'production' || value === 'sandbox') {
    return value;
  }

  throw new Error(
    `Invalid CASHFREE_VERIFICATION_ENV="${String(raw).trim()}". Expected "production" or "sandbox".`,
  );
}

export function resolveCashfreeVerificationBaseUrl(
  environment: CashfreeVerificationEnvironment,
): string {
  return environment === 'production'
    ? CASHFREE_PRODUCTION_BASE_URL
    : CASHFREE_SANDBOX_BASE_URL;
}

@Injectable()
export class CashfreeConfigService {
  private readonly logger = new Logger(CashfreeConfigService.name);
  private loggedEnvironment = false;

  constructor(private readonly configService: ConfigService) {}

  getConfig(): CashfreeDigiLockerConfig {
    const rawEnv =
      this.configService.get<string>('CASHFREE_VERIFICATION_ENV') ??
      process.env.CASHFREE_VERIFICATION_ENV;

    const environment = resolveCashfreeVerificationEnvironment(rawEnv);
    const baseUrl = resolveCashfreeVerificationBaseUrl(environment);

    const clientId = (
      this.configService.get<string>('CASHFREE_CLIENT_ID') ||
      process.env.CASHFREE_CLIENT_ID ||
      ''
    ).trim();

    const clientSecret = (
      this.configService.get<string>('CASHFREE_CLIENT_SECRET') ||
      process.env.CASHFREE_CLIENT_SECRET ||
      ''
    ).trim();

    const rawPublicKey = (
      this.configService.get<string>('CASHFREE_PUBLIC_KEY') ||
      process.env.CASHFREE_PUBLIC_KEY ||
      ''
    ).trim();

    let publicKey: string | null = null;
    if (rawPublicKey) {
      publicKey = normalizeCashfreePublicKeyPem(rawPublicKey);
    }

    const redirectUrl = (
      this.configService.get<string>('CASHFREE_DIGILOCKER_REDIRECT_URL') ||
      process.env.CASHFREE_DIGILOCKER_REDIRECT_URL ||
      'https://bhaiway-backend.onrender.com/api/kyc/aadhaar/digilocker/callback'
    ).trim();

    if (!this.loggedEnvironment) {
      this.loggedEnvironment = true;
      this.logger.log(
        `[CashfreeConfig] Using Cashfree verification environment: ${environment}`,
      );
      this.logger.log(
        `[CashfreeConfig] DigiLocker endpoint: ${baseUrl}/digilocker`,
      );
      this.logger.log(
        `[CashfreeConfig] Public Key 2FA: ${publicKey ? 'enabled' : 'disabled'}`,
      );
    }

    return {
      environment,
      baseUrl,
      clientId,
      clientSecret,
      publicKey,
      redirectUrl,
      timeoutMs: 10000,
    };
  }

  isConfigured(): boolean {
    const config = this.getConfig();
    return Boolean(config.clientId && config.clientSecret);
  }
}
