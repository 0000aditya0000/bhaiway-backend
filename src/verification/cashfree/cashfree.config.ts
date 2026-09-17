import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const CASHFREE_SANDBOX_BASE_URL =
  'https://sandbox.cashfree.com/verification';
export const CASHFREE_PRODUCTION_BASE_URL =
  'https://api.cashfree.com/verification';

export interface CashfreeDigiLockerConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  timeoutMs: number;
}

@Injectable()
export class CashfreeConfigService {
  constructor(private readonly configService: ConfigService) {}

  getConfig(): CashfreeDigiLockerConfig {
    const env = (
      this.configService.get<string>('CASHFREE_VERIFICATION_ENV') ??
      process.env.CASHFREE_VERIFICATION_ENV ??
      'sandbox'
    )
      .trim()
      .toLowerCase();

    const baseUrl =
      env === 'production'
        ? CASHFREE_PRODUCTION_BASE_URL
        : CASHFREE_SANDBOX_BASE_URL;

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

    const redirectUrl = (
      this.configService.get<string>('CASHFREE_DIGILOCKER_REDIRECT_URL') ||
      process.env.CASHFREE_DIGILOCKER_REDIRECT_URL ||
      'https://bhaiway-backend.onrender.com/api/kyc/aadhaar/digilocker/callback'
    ).trim();

    return {
      baseUrl,
      clientId,
      clientSecret,
      redirectUrl,
      timeoutMs: 10000,
    };
  }

  isConfigured(): boolean {
    const config = this.getConfig();
    return Boolean(config.clientId && config.clientSecret);
  }
}
