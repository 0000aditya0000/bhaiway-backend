import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { AuthService } from '../auth/auth.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { Wallet, WalletStatus } from '../wallet/entities/wallet.entity';
import {
  ADMIN_BOOTSTRAP_PHONE,
  ADMIN_BOOTSTRAP_USER_ID,
  ADMIN_BOOTSTRAP_USERNAME_DEFAULT,
  ADMIN_PERMISSION_DASHBOARD_VIEW,
} from './admin.constants';
import {
  hashAdminPassword,
  verifyAdminPassword,
} from './admin-password.util';
import { AdminUser } from './entities/admin-user.entity';

@Injectable()
export class AdminAuthService implements OnModuleInit {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
    private readonly dataSource: DataSource,
    @InjectRepository(AdminUser)
    private readonly adminUserRepository: Repository<AdminUser>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureBootstrapAdmin();
    } catch (error) {
      this.logger.error(
        `Admin bootstrap failed: ${(error as Error).message}`,
      );
    }
  }

  async login(usernameRaw: string, password: string) {
    const username = usernameRaw.trim().toLowerCase();
    if (!username || !password) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'ADMIN_INVALID_CREDENTIALS',
        message: 'Invalid username or password',
        error: 'Unauthorized',
      });
    }

    const admin = await this.adminUserRepository.findOne({
      where: { username, isActive: true },
    });

    // Constant-time-ish failure path: always run a verify when hash missing.
    const hash = admin?.passwordHash ?? hashAdminPassword('invalid-dummy');
    const matches = admin?.passwordHash
      ? verifyAdminPassword(password, hash)
      : false;

    if (!admin || !admin.passwordHash || !matches) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'ADMIN_INVALID_CREDENTIALS',
        message: 'Invalid username or password',
        error: 'Unauthorized',
      });
    }

    const accessToken = await this.authService.signAccessToken(admin.userId);

    return {
      accessToken,
      admin: {
        id: admin.id,
        username: admin.username ?? username,
        permissions: admin.permissions ?? [],
      },
    };
  }

  /**
   * Ensures the configured bootstrap admin exists.
   * Username/password come from env (never hardcoded in source).
   */
  async ensureBootstrapAdmin(): Promise<void> {
    const username = (
      this.configService.get<string>('ADMIN_USERNAME') ||
      ADMIN_BOOTSTRAP_USERNAME_DEFAULT
    )
      .trim()
      .toLowerCase();
    const password = this.configService.get<string>('ADMIN_PASSWORD') ?? '';

    if (!password.trim()) {
      this.logger.warn(
        'ADMIN_PASSWORD is not set — bootstrap admin login will not be created/updated',
      );
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      let user = await manager.getRepository(User).findOne({
        where: { id: ADMIN_BOOTSTRAP_USER_ID },
      });

      if (!user) {
        const byPhone = await manager.getRepository(User).findOne({
          where: { phone: ADMIN_BOOTSTRAP_PHONE },
        });
        if (byPhone) {
          user = byPhone;
        } else {
          user = manager.getRepository(User).create({
            id: ADMIN_BOOTSTRAP_USER_ID,
            phone: ADMIN_BOOTSTRAP_PHONE,
            phoneVerified: true,
            email: null,
            emailVerified: false,
            status: UserStatus.ACTIVE,
            lastLoginAt: new Date(),
          });
          user = await manager.getRepository(User).save(user);

          const wallet = await manager.getRepository(Wallet).save(
            manager.getRepository(Wallet).create({
              userId: user.id,
              status: WalletStatus.ACTIVE,
            }),
          );
          await manager.getRepository(WalletBalance).save(
            manager.getRepository(WalletBalance).create({
              walletId: wallet.id,
              purchasedAvailable: '0',
              promotionalAvailable: '0',
              driverEarnedAvailable: '0',
              purchasedHeld: '0',
              promotionalHeld: '0',
              driverEarnedHeld: '0',
            }),
          );
        }
      }

      let admin = await manager.getRepository(AdminUser).findOne({
        where: { userId: user.id },
      });

      const passwordHash = hashAdminPassword(password);
      const permissions = Array.from(
        new Set([
          ...(admin?.permissions ?? []),
          ADMIN_PERMISSION_DASHBOARD_VIEW,
        ]),
      );

      if (!admin) {
        admin = manager.getRepository(AdminUser).create({
          userId: user.id,
          username,
          passwordHash,
          permissions,
          isActive: true,
        });
      } else {
        admin.username = username;
        admin.passwordHash = passwordHash;
        admin.permissions = permissions;
        admin.isActive = true;
      }

      await manager.getRepository(AdminUser).save(admin);
    });

    this.logger.log(
      `Bootstrap admin ready username=${username} permission=${ADMIN_PERMISSION_DASHBOARD_VIEW}`,
    );
  }
}
