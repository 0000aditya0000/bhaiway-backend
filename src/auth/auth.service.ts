import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';

import { SelfReferralNotAllowedError } from '../referrals/errors/referral.errors';
import { ReferralService } from '../referrals/referral.service';
import { normalizeReferralCode } from '../referrals/referral-code.util';
import { User, UserStatus } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { isProfileCompleted } from '../users/profile-completion';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { Wallet, WalletStatus } from '../wallet/entities/wallet.entity';
import {
  isPlatformPhone,
  isPlatformUserId,
  PLATFORM_PHONE,
} from '../wallet/platform-wallet.constants';
import { Msg91InvalidAccessTokenError } from './errors/msg91.errors';
import { OTP_PROVIDER } from './providers/otp-provider.interface';
import type {
  OtpProvider,
  VerifiedOtpUser,
} from './providers/otp-provider.interface';

export interface AuthLoginResult {
  accessToken: string;
  user: {
    id: string;
    phone: string;
    phoneVerified: boolean;
    profileCompleted: boolean;
  };
}

export interface SendOtpResult {
  success: boolean;
  message: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /** Simple in-process attempt window for review login abuse protection. */
  private readonly reviewAttemptTimestamps = new Map<string, number[]>();
  private static readonly REVIEW_ATTEMPT_WINDOW_MS = 60_000;
  private static readonly REVIEW_ATTEMPT_MAX = 10;

  /** Test/helper: clear in-memory review rate-limit buckets. */
  clearReviewRateLimitState(): void {
    this.reviewAttemptTimestamps.clear();
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly dataSource: DataSource,
    @Inject(OTP_PROVIDER)
    private readonly otpProvider: OtpProvider,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserProfile)
    private readonly userProfileRepository: Repository<UserProfile>,
    @Inject(forwardRef(() => ReferralService))
    private readonly referralService: ReferralService,
  ) {}

  /**
   * Verifies the MSG91 access token, then authenticates with the verified phone.
   * Phone is taken only from MSG91 response.message — never from the client.
   */
  async verifyMsg91AccessToken(
    accessToken: string,
    referralCode?: string | null,
  ): Promise<AuthLoginResult> {
    if (!accessToken?.trim()) {
      throw new Msg91InvalidAccessTokenError();
    }

    const verified = await this.otpProvider.verifyAccessToken(accessToken);
    return this.authenticateVerifiedPhone(
      verified.phone,
      verified.email,
      referralCode,
    );
  }

  /**
   * Unified MSG91 verify entry used by the controller.
   *
   * - accessToken → normal MSG91 widget path (unchanged)
   * - phone + otp → Play Store review path only when all three env conditions match
   * - referralCode → applied only when creating a NEW user
   */
  async verifyMsg91(input: {
    accessToken?: string;
    phone?: string;
    otp?: string;
    referralCode?: string | null;
  }): Promise<AuthLoginResult> {
    const accessToken = input.accessToken?.trim();
    const phone = input.phone?.trim();
    const otp = input.otp?.trim();
    const referralCode = normalizeReferralCode(input.referralCode);

    const hasPhoneOtp = Boolean(phone && otp);
    const hasAccessToken = Boolean(accessToken);

    if (hasPhoneOtp) {
      return this.verifyPlayReviewCredentials(phone!, otp!, referralCode);
    }

    if (hasAccessToken) {
      return this.verifyMsg91AccessToken(accessToken!, referralCode);
    }

    throw new Msg91InvalidAccessTokenError(
      'MSG91 access token or review phone/OTP credentials are required',
    );
  }

  /**
   * OTP send stub for mobile compatibility.
   *
   * Review phone (when enabled): acknowledge success without sending SMS.
   * All other phones: MSG91 Widget remains responsible for delivery — return a
   * generic client-compatible success without exposing whether the phone is special.
   *
   * Never returns the OTP value.
   */
  async sendMsg91Otp(phoneRaw: string): Promise<SendOtpResult> {
    if (!phoneRaw?.trim()) {
      throw new BadRequestException('Phone is required');
    }

    const phone = this.normalizePhone(phoneRaw);
    this.assertNotPlatformIdentity(phone);
    this.assertReviewRateLimit(phone);

    const configuredReviewPhone = this.getConfiguredReviewPhone();
    if (
      this.isPlayReviewLoginEnabled() &&
      configuredReviewPhone &&
      this.phonesMatch(phone, configuredReviewPhone)
    ) {
      this.logger.log('[AUTH] Play review OTP send acknowledged');
      return { success: true, message: 'OTP sent' };
    }

    // Non-review phones: do not send SMS from this backend (MSG91 Widget owns delivery).
    // Return the same generic shape so clients are not fingerprinted.
    return { success: true, message: 'OTP sent' };
  }

  /**
   * Shared login/signup entry used by MSG91 and development auth.
   * Phone must already be verified by a trusted source.
   */
  async authenticateVerifiedPhone(
    phone: string,
    email?: string,
    referralCode?: string | null,
  ): Promise<AuthLoginResult> {
    return this.loginOrRegisterWithVerifiedIdentity({
      phone,
      email,
      verified: true,
      referralCode,
    });
  }

  /**
   * Development-only login. Never available when NODE_ENV=production.
   */
  async devLogin(): Promise<AuthLoginResult> {
    this.assertDevAuthAllowed();

    const configuredPhone = this.configService
      .get<string>('DEV_AUTH_PHONE')
      ?.trim();
    if (!configuredPhone) {
      throw new BadRequestException('DEV_AUTH_PHONE is not configured');
    }

    return this.authenticateVerifiedPhone(configuredPhone);
  }

  /**
   * Completes BhaiWay login/signup once a verified phone is available.
   */
  async loginOrRegisterWithVerifiedIdentity(
    identity: VerifiedOtpUser & { referralCode?: string | null },
  ): Promise<AuthLoginResult> {
    if (!identity.verified || !identity.phone?.trim()) {
      throw new Msg91InvalidAccessTokenError(
        'Verified phone identity is required',
      );
    }

    const phone = this.normalizePhone(identity.phone);
    this.assertNotPlatformIdentity(phone);
    const referralCode = normalizeReferralCode(identity.referralCode);

    let user = await this.userRepository.findOne({ where: { phone } });

    if (!user) {
      try {
        user = await this.createUserWithWallet(
          phone,
          identity.email,
          referralCode,
        );
      } catch (error) {
        // Concurrent first login: unique phone constraint → reuse winner.
        // Winner already owns any referral; loser must not create another.
        if (this.isUniquePhoneViolation(error)) {
          user = await this.userRepository.findOne({ where: { phone } });
          if (!user) {
            throw error;
          }
        } else {
          throw error;
        }
      }
    }
    // Existing users: referralCode is intentionally ignored.

    this.assertNotPlatformIdentity(user.phone, user.id);
    user.phoneVerified = true;
    user.lastLoginAt = new Date();
    if (identity.email && !user.email) {
      user.email = identity.email;
    }
    user = await this.userRepository.save(user);

    const profile = await this.userProfileRepository.findOne({
      where: { userId: user.id },
    });

    const accessToken = await this.signAccessToken(user.id);

    return {
      accessToken,
      user: {
        id: user.id,
        phone: user.phone,
        phoneVerified: user.phoneVerified,
        profileCompleted: isProfileCompleted(profile),
      },
    };
  }

  async signAccessToken(userId: string): Promise<string> {
    if (isPlatformUserId(userId)) {
      throw new ForbiddenException('Platform identity cannot authenticate');
    }

    const expiresIn = this.configService.get<string>(
      'JWT_ACCESS_EXPIRES_IN',
      '15m',
    );

    return this.jwtService.signAsync(
      { sub: userId },
      {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: expiresIn as unknown as number,
      },
    );
  }

  normalizePhone(phone: string): string {
    return phone.replace(/\s+/g, '').trim();
  }

  isPlayReviewLoginEnabled(): boolean {
    return (
      this.configService.get<string>('PLAY_REVIEW_LOGIN_ENABLED') === 'true'
    );
  }

  isDevAuthEnabled(): boolean {
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      return false;
    }
    return this.configService.get<string>('DEV_AUTH_ENABLED') === 'true';
  }

  /**
   * Play Store review credentials check.
   * Requires ALL of: feature enabled, phone match, OTP match.
   * Never authenticates on OTP alone.
   */
  private async verifyPlayReviewCredentials(
    phoneRaw: string,
    otpRaw: string,
    referralCode?: string | null,
  ): Promise<AuthLoginResult> {
    const phone = this.normalizePhone(phoneRaw);
    const otp = otpRaw.trim();

    this.assertNotPlatformIdentity(phone);
    this.assertReviewRateLimit(phone);

    if (!this.isPlayReviewLoginEnabled()) {
      // Do not reveal that a review account exists or that the feature is off.
      throw new UnauthorizedException('Invalid credentials');
    }

    const configuredPhone = this.getConfiguredReviewPhone();
    const configuredOtp = this.getConfiguredReviewOtp();

    if (!configuredPhone || !configuredOtp) {
      this.logger.warn(
        '[AUTH] Play review login enabled but phone/OTP env is incomplete',
      );
      throw new UnauthorizedException('Invalid credentials');
    }

    const phoneOk = this.phonesMatch(phone, configuredPhone);
    const otpOk = otp === configuredOtp;

    if (!phoneOk || !otpOk) {
      throw new UnauthorizedException('Invalid credentials');
    }

    this.logger.log('[AUTH] Play review authentication used');

    return this.authenticateVerifiedPhone(
      configuredPhone,
      undefined,
      referralCode,
    );
  }

  private getConfiguredReviewPhone(): string | null {
    const value = this.configService.get<string>('PLAY_REVIEW_PHONE')?.trim();
    return value ? this.normalizePhone(value) : null;
  }

  private getConfiguredReviewOtp(): string | null {
    const value = this.configService.get<string>('PLAY_REVIEW_OTP')?.trim();
    return value || null;
  }

  private phonesMatch(submitted: string, configured: string): boolean {
    return (
      this.normalizePhone(submitted) === this.normalizePhone(configured)
    );
  }

  private assertReviewRateLimit(phone: string): void {
    const now = Date.now();
    const windowStart = now - AuthService.REVIEW_ATTEMPT_WINDOW_MS;
    const prior = (this.reviewAttemptTimestamps.get(phone) ?? []).filter(
      (ts) => ts >= windowStart,
    );
    prior.push(now);
    this.reviewAttemptTimestamps.set(phone, prior);

    if (prior.length > AuthService.REVIEW_ATTEMPT_MAX) {
      throw new UnauthorizedException('Invalid credentials');
    }
  }

  /**
   * Platform operating account must never receive a normal user JWT.
   */
  private assertNotPlatformIdentity(phone: string, userId?: string): void {
    if (isPlatformPhone(phone) || phone === PLATFORM_PHONE) {
      throw new ForbiddenException('Platform identity cannot authenticate');
    }
    if (userId && isPlatformUserId(userId)) {
      throw new ForbiddenException('Platform identity cannot authenticate');
    }
  }

  private assertDevAuthAllowed(): void {
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      throw new NotFoundException();
    }

    if (this.configService.get<string>('DEV_AUTH_ENABLED') !== 'true') {
      throw new ForbiddenException('Development authentication is disabled');
    }
  }

  private isUniquePhoneViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      let current: unknown = error;
      while (current && typeof current === 'object') {
        const record = current as {
          code?: string;
          constraint?: string;
          driverError?: { code?: string; constraint?: string };
          cause?: unknown;
        };
        const code = record.code ?? record.driverError?.code;
        const constraint =
          record.constraint ?? record.driverError?.constraint ?? '';
        if (
          code === '23505' &&
          (constraint.includes('phone') || constraint.includes('users'))
        ) {
          return true;
        }
        current = record.cause ?? record.driverError;
      }
      return false;
    }

    const driver = error.driverError as
      | { code?: string; constraint?: string }
      | undefined;
    return (
      driver?.code === '23505' &&
      Boolean(
        driver.constraint?.includes('phone') ||
          driver.constraint?.includes('users'),
      )
    );
  }

  private async createUserWithWallet(
    phone: string,
    email?: string,
    referralCode?: string | null,
  ): Promise<User> {
    return this.dataSource.transaction(async (manager) => {
      // Validate referral BEFORE creating the user so invalid codes never leave a partial account.
      const referrer = await this.referralService.resolveReferrerInTransaction(
        manager,
        referralCode,
      );

      const ownCode =
        await this.referralService.allocateUniqueReferralCode(manager);

      const user = manager.create(User, {
        phone,
        phoneVerified: true,
        email: email ?? null,
        emailVerified: false,
        referralCode: ownCode,
        status: UserStatus.ACTIVE,
        lastLoginAt: new Date(),
      });
      const savedUser = await manager.save(User, user);

      const wallet = manager.create(Wallet, {
        userId: savedUser.id,
        status: WalletStatus.ACTIVE,
      });
      const savedWallet = await manager.save(Wallet, wallet);

      const balance = manager.create(WalletBalance, {
        walletId: savedWallet.id,
        purchasedAvailable: '0',
        promotionalAvailable: '0',
        driverEarnedAvailable: '0',
        purchasedHeld: '0',
        promotionalHeld: '0',
        driverEarnedHeld: '0',
      });
      await manager.save(WalletBalance, balance);

      if (referrer) {
        if (referrer.id === savedUser.id) {
          throw new SelfReferralNotAllowedError();
        }
        await this.referralService.applyReferralRewardsInTransaction(manager, {
          referrer,
          referredUserId: savedUser.id,
          referralCode: referrer.referralCode!,
        });
      }

      return savedUser;
    });
  }
}
