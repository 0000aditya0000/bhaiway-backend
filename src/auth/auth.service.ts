import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

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

@Injectable()
export class AuthService {
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
  ) {}

  /**
   * Verifies the MSG91 access token, then authenticates with the verified phone.
   * Phone is taken only from MSG91 response.message — never from the client.
   */
  async verifyMsg91AccessToken(accessToken: string): Promise<AuthLoginResult> {
    if (!accessToken?.trim()) {
      throw new Msg91InvalidAccessTokenError();
    }

    const verified = await this.otpProvider.verifyAccessToken(accessToken);
    return this.authenticateVerifiedPhone(verified.phone, verified.email);
  }

  /**
   * Shared login/signup entry used by MSG91 (future) and development auth.
   * Phone must already be verified by a trusted source.
   */
  async authenticateVerifiedPhone(
    phone: string,
    email?: string,
  ): Promise<AuthLoginResult> {
    return this.loginOrRegisterWithVerifiedIdentity({
      phone,
      email,
      verified: true,
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
    identity: VerifiedOtpUser,
  ): Promise<AuthLoginResult> {
    if (!identity.verified || !identity.phone?.trim()) {
      throw new Msg91InvalidAccessTokenError(
        'Verified phone identity is required',
      );
    }

    const phone = this.normalizePhone(identity.phone);
    this.assertNotPlatformIdentity(phone);

    let user = await this.userRepository.findOne({ where: { phone } });

    if (!user) {
      user = await this.createUserWithWallet(phone, identity.email);
    } else {
      this.assertNotPlatformIdentity(user.phone, user.id);
      user.phoneVerified = true;
      user.lastLoginAt = new Date();
      if (identity.email && !user.email) {
        user.email = identity.email;
      }
      user = await this.userRepository.save(user);
    }

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

  isDevAuthEnabled(): boolean {
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      return false;
    }
    return this.configService.get<string>('DEV_AUTH_ENABLED') === 'true';
  }

  private assertDevAuthAllowed(): void {
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      throw new NotFoundException();
    }

    if (this.configService.get<string>('DEV_AUTH_ENABLED') !== 'true') {
      throw new ForbiddenException('Development authentication is disabled');
    }
  }

  private async createUserWithWallet(
    phone: string,
    email?: string,
  ): Promise<User> {
    return this.dataSource.transaction(async (manager) => {
      const user = manager.create(User, {
        phone,
        phoneVerified: true,
        email: email ?? null,
        emailVerified: false,
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

      return savedUser;
    });
  }
}
