import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { UsersModule } from '../users/users.module';
import { User } from '../users/entities/user.entity';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';
import { AuthModule } from './auth.module';
import { AuthService } from './auth.service';
import { Msg91ResponseFormatError } from './errors/msg91.errors';
import { OTP_PROVIDER } from './providers/otp-provider.interface';

describe('AuthService.devLogin', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let configService: ConfigService;
  let jwtService: JwtService;
  let userRepository: Repository<User>;
  let walletRepository: Repository<Wallet>;
  let balanceRepository: Repository<WalletBalance>;
  let configGetSpy: jest.SpyInstance;
  const tracked: TestWalletContext[] = [];

  const baseConfig: Record<string, string | undefined> = {};

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.DATABASE_URL);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env.test',
        }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: process.env.DATABASE_URL,
          autoLoadEntities: true,
          synchronize: false,
          logging: false,
        }),
        AuthModule,
        UsersModule,
        WalletModule,
      ],
    })
      .overrideProvider(OTP_PROVIDER)
      .useValue({
        verifyAccessToken: jest
          .fn()
          .mockRejectedValue(new Msg91ResponseFormatError()),
      })
      .compile();

    dataSource = moduleRef.get(DataSource);
    authService = moduleRef.get(AuthService);
    configService = moduleRef.get(ConfigService);
    jwtService = moduleRef.get(JwtService);
    userRepository = dataSource.getRepository(User);
    walletRepository = dataSource.getRepository(Wallet);
    balanceRepository = dataSource.getRepository(WalletBalance);

    const originalGet = configService.get.bind(configService);
    configGetSpy = jest
      .spyOn(configService, 'get')
      .mockImplementation((key: string, defaultValue?: unknown) => {
        if (Object.prototype.hasOwnProperty.call(baseConfig, key)) {
          return baseConfig[key];
        }
        return originalGet(key, defaultValue as never);
      });
  });

  afterEach(async () => {
    baseConfig.NODE_ENV = 'test';
    baseConfig.DEV_AUTH_ENABLED = 'false';
    delete baseConfig.DEV_AUTH_PHONE;

    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await cleanupTestWallet(dataSource, ctx);
      }
    }
  });

  afterAll(async () => {
    configGetSpy.mockRestore();
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  async function trackUser(userId: string, phone: string) {
    const wallet = await walletRepository.findOneByOrFail({ userId });
    const balance = await balanceRepository.findOneByOrFail({
      walletId: wallet.id,
    });
    tracked.push({
      userId,
      walletId: wallet.id,
      balanceId: balance.id,
      phone,
    });
  }

  it('rejects when development auth is disabled by default', async () => {
    baseConfig.NODE_ENV = 'test';
    baseConfig.DEV_AUTH_ENABLED = 'false';

    await expect(authService.devLogin()).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(authService.isDevAuthEnabled()).toBe(false);
  });

  it('rejects when NODE_ENV is production even if DEV_AUTH_ENABLED=true', async () => {
    baseConfig.NODE_ENV = 'production';
    baseConfig.DEV_AUTH_ENABLED = 'true';
    baseConfig.DEV_AUTH_PHONE = '+919876543210';

    await expect(authService.devLogin()).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(authService.isDevAuthEnabled()).toBe(false);
  });

  it('creates a verified development user with wallet and balance when enabled', async () => {
    const phone = `+91${Date.now().toString().slice(-10)}`;
    baseConfig.NODE_ENV = 'test';
    baseConfig.DEV_AUTH_ENABLED = 'true';
    baseConfig.DEV_AUTH_PHONE = phone;

    const result = await authService.devLogin();
    await trackUser(result.user.id, phone);

    expect(result.user.phone).toBe(phone);
    expect(result.user.phoneVerified).toBe(true);
    expect(result.accessToken).toBeTruthy();

    const wallet = await walletRepository.findOneByOrFail({
      userId: result.user.id,
    });
    const balance = await balanceRepository.findOneByOrFail({
      walletId: wallet.id,
    });

    expect(wallet.status).toBe('ACTIVE');
    expect(balance.purchasedAvailable).toBe('0');
    expect(balance.promotionalAvailable).toBe('0');
    expect(balance.driverEarnedAvailable).toBe('0');
    expect(balance.purchasedHeld).toBe('0');
    expect(balance.promotionalHeld).toBe('0');
    expect(balance.driverEarnedHeld).toBe('0');
  });

  it('logs in an existing development user without duplication', async () => {
    const phone = `+91${Date.now().toString().slice(-10)}`;
    baseConfig.NODE_ENV = 'test';
    baseConfig.DEV_AUTH_ENABLED = 'true';
    baseConfig.DEV_AUTH_PHONE = phone;

    const first = await authService.devLogin();
    await trackUser(first.user.id, phone);

    const second = await authService.devLogin();
    expect(second.user.id).toBe(first.user.id);

    const users = await userRepository.find({ where: { phone } });
    expect(users).toHaveLength(1);
    expect(users[0].phoneVerified).toBe(true);

    const wallets = await walletRepository.find({
      where: { userId: first.user.id },
    });
    expect(wallets).toHaveLength(1);
  });

  it('generates a JWT containing only sub as the identity claim', async () => {
    const phone = `+91${Date.now().toString().slice(-10)}`;
    baseConfig.NODE_ENV = 'test';
    baseConfig.DEV_AUTH_ENABLED = 'true';
    baseConfig.DEV_AUTH_PHONE = phone;

    const result = await authService.devLogin();
    await trackUser(result.user.id, phone);

    const payload = jwtService.decode(result.accessToken) as Record<
      string,
      unknown
    >;
    expect(payload.sub).toBe(result.user.id);
    expect(payload.phone).toBeUndefined();
    expect(payload.walletId).toBeUndefined();
  });

  it('uses authenticateVerifiedPhone so creation remains atomic on failure', async () => {
    const phone = `+91${Date.now().toString().slice(-10)}`;
    baseConfig.NODE_ENV = 'test';
    baseConfig.DEV_AUTH_ENABLED = 'true';
    baseConfig.DEV_AUTH_PHONE = phone;

    const spy = jest
      .spyOn(dataSource, 'transaction')
      .mockRejectedValueOnce(new Error('Forced wallet initialization failure'));

    try {
      await expect(authService.devLogin()).rejects.toThrow(
        'Forced wallet initialization failure',
      );
    } finally {
      spy.mockRestore();
    }

    const users = await userRepository.find({ where: { phone } });
    expect(users).toHaveLength(0);
  });

  it('reuses authenticateVerifiedPhone for the shared login path', async () => {
    const phone = `+91${Date.now().toString().slice(-10)}`;
    const spy = jest.spyOn(authService, 'authenticateVerifiedPhone');

    baseConfig.NODE_ENV = 'test';
    baseConfig.DEV_AUTH_ENABLED = 'true';
    baseConfig.DEV_AUTH_PHONE = phone;

    const result = await authService.devLogin();
    await trackUser(result.user.id, phone);

    expect(spy).toHaveBeenCalledWith(phone);
    spy.mockRestore();
  });
});
