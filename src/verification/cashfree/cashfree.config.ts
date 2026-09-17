import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Cashfree Verification API — production only. */
export const CASHFREE_PRODUCTION_BASE_URL =
  'https://api.cashfree.com/verification';

export interface CashfreeDigiLockerConfig {
  environment: 'production';
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  timeoutMs: number;
}

@Injectable()
export class CashfreeConfigService {
  private readonly logger = new Logger(CashfreeConfigService.name);
  private loggedEnvironment = false;

  constructor(private readonly configService: ConfigService) {}

  getConfig(): CashfreeDigiLockerConfig {
    const baseUrl = CASHFREE_PRODUCTION_BASE_URL;

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

    if (!this.loggedEnvironment) {
      this.loggedEnvironment = true;
      this.logger.log(
        '[CashfreeConfig] Using Cashfree verification environment: production',
      );
      this.logger.log(
        `[CashfreeConfig] DigiLocker endpoint: ${baseUrl}/digilocker`,
      );
    }

    return {
      environment: 'production',
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
