import { UnauthorizedException } from '@nestjs/common';
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

describe('AuthService Play Store review login', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let configService: ConfigService;
  let jwtService: JwtService;
  let userRepository: Repository<User>;
  let walletRepository: Repository<Wallet>;
  let balanceRepository: Repository<WalletBalance>;
  let verifyAccessTokenMock: jest.Mock;
  let configGetSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  const tracked: TestWalletContext[] = [];
  const baseConfig: Record<string, string | undefined> = {};

  const REVIEW_PHONE = '9761454075';
  const REVIEW_OTP = '1234';

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.DATABASE_URL);

    verifyAccessTokenMock = jest.fn();

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
        verifyAccessToken: verifyAccessTokenMock,
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

  beforeEach(() => {
    verifyAccessTokenMock.mockReset();
    authService.clearReviewRateLimitState();
    baseConfig.PLAY_REVIEW_LOGIN_ENABLED = 'false';
    delete baseConfig.PLAY_REVIEW_PHONE;
    delete baseConfig.PLAY_REVIEW_OTP;

    logSpy = jest.spyOn(authService['logger'], 'log').mockImplementation();
    warnSpy = jest.spyOn(authService['logger'], 'warn').mockImplementation();
  });

  afterEach(async () => {
    logSpy.mockRestore();
    warnSpy.mockRestore();

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

  function enableReviewLogin(
    phone = REVIEW_PHONE,
    otp = REVIEW_OTP,
  ): void {
    baseConfig.PLAY_REVIEW_LOGIN_ENABLED = 'true';
    baseConfig.PLAY_REVIEW_PHONE = phone;
    baseConfig.PLAY_REVIEW_OTP = otp;
  }

  it('TEST 1: disabled — review phone+otp does not bypass MSG91', async () => {
    baseConfig.PLAY_REVIEW_LOGIN_ENABLED = 'false';
    baseConfig.PLAY_REVIEW_PHONE = REVIEW_PHONE;
    baseConfig.PLAY_REVIEW_OTP = REVIEW_OTP;

    await expect(
      authService.verifyMsg91({
        phone: REVIEW_PHONE,
        otp: REVIEW_OTP,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(verifyAccessTokenMock).not.toHaveBeenCalled();
  });

  it('TEST 2: enabled + correct phone + correct OTP → normal JWT response', async () => {
    enableReviewLogin();

    const result = await authService.verifyMsg91({
      phone: REVIEW_PHONE,
      otp: REVIEW_OTP,
    });
    await trackUser(result.user.id, REVIEW_PHONE);

    expect(result.accessToken).toBeTruthy();
    expect(result.user.phone).toBe(REVIEW_PHONE);
    expect(result.user.phoneVerified).toBe(true);
    expect(result.user).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        phone: REVIEW_PHONE,
        phoneVerified: true,
        profileCompleted: expect.any(Boolean),
      }),
    );
    expect(result).not.toHaveProperty('isReviewUser');
    expect(verifyAccessTokenMock).not.toHaveBeenCalled();

    const payload = jwtService.decode(result.accessToken) as { sub: string };
    expect(payload.sub).toBe(result.user.id);
  });

  it('TEST 3: enabled + wrong OTP → failure', async () => {
    enableReviewLogin();

    await expect(
      authService.verifyMsg91({
        phone: REVIEW_PHONE,
        otp: '9999',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('TEST 4: enabled + correct OTP + wrong phone → failure', async () => {
    enableReviewLogin();

    await expect(
      authService.verifyMsg91({
        phone: '9000000000',
        otp: REVIEW_OTP,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('TEST 5: disabled + correct credentials → failure', async () => {
    baseConfig.PLAY_REVIEW_LOGIN_ENABLED = 'false';
    baseConfig.PLAY_REVIEW_PHONE = REVIEW_PHONE;
    baseConfig.PLAY_REVIEW_OTP = REVIEW_OTP;

    await expect(
      authService.verifyMsg91({
        phone: REVIEW_PHONE,
        otp: REVIEW_OTP,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('TEST 6–7: creates review user once and reuses on repeat login', async () => {
    enableReviewLogin();

    const first = await authService.verifyMsg91({
      phone: REVIEW_PHONE,
      otp: REVIEW_OTP,
    });
    await trackUser(first.user.id, REVIEW_PHONE);

    const second = await authService.verifyMsg91({
      phone: REVIEW_PHONE,
      otp: REVIEW_OTP,
    });

    expect(second.user.id).toBe(first.user.id);
    const users = await userRepository.find({ where: { phone: REVIEW_PHONE } });
    expect(users).toHaveLength(1);

    const wallets = await walletRepository.find({
      where: { userId: first.user.id },
    });
    expect(wallets).toHaveLength(1);
  });

  it('TEST 8: phone normalization matches existing auth (whitespace stripped)', async () => {
    enableReviewLogin();

    const result = await authService.verifyMsg91({
      phone: ` ${REVIEW_PHONE} `,
      otp: REVIEW_OTP,
    });
    await trackUser(result.user.id, REVIEW_PHONE);

    expect(result.user.phone).toBe(REVIEW_PHONE);
  });

  it('TEST 9: normal MSG91 accessToken path remains unchanged for non-review users', async () => {
    enableReviewLogin();
    const phone = `+91${Date.now().toString().slice(-10)}`;
    verifyAccessTokenMock.mockResolvedValue({
      phone,
      verified: true,
    });

    const result = await authService.verifyMsg91({
      accessToken: 'msg91-access-token',
    });
    await trackUser(result.user.id, phone);

    expect(verifyAccessTokenMock).toHaveBeenCalledWith('msg91-access-token');
    expect(result.user.phone).toBe(phone);
  });

  it('TEST 10: review JWT is a normal access token (sub only) — no elevated claims', async () => {
    enableReviewLogin();

    const result = await authService.verifyMsg91({
      phone: REVIEW_PHONE,
      otp: REVIEW_OTP,
    });
    await trackUser(result.user.id, REVIEW_PHONE);

    const payload = jwtService.decode(result.accessToken) as Record<
      string,
      unknown
    >;
    expect(payload.sub).toBe(result.user.id);
    expect(payload.role).toBeUndefined();
    expect(payload.isReviewUser).toBeUndefined();
    expect(payload.bypassVerification).toBeUndefined();
  });

  it('TEST 11: review OTP and phone+otp never appear together in logs', async () => {
    enableReviewLogin();

    await authService.verifyMsg91({
      phone: REVIEW_PHONE,
      otp: REVIEW_OTP,
    }).then(async (result) => {
      await trackUser(result.user.id, REVIEW_PHONE);
    });

    const allLogArgs = [...logSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map(String)
      .join(' ');

    expect(allLogArgs).toContain('Play review authentication used');
    expect(allLogArgs).not.toContain(REVIEW_OTP);
    expect(allLogArgs).not.toMatch(
      new RegExp(`${REVIEW_PHONE}.*${REVIEW_OTP}`),
    );
  });

  it('TEST 12: concurrent review logins do not create duplicate users', async () => {
    enableReviewLogin();

    const results = await Promise.all([
      authService.verifyMsg91({ phone: REVIEW_PHONE, otp: REVIEW_OTP }),
      authService.verifyMsg91({ phone: REVIEW_PHONE, otp: REVIEW_OTP }),
      authService.verifyMsg91({ phone: REVIEW_PHONE, otp: REVIEW_OTP }),
    ]);

    const ids = new Set(results.map((r) => r.user.id));
    expect(ids.size).toBe(1);
    await trackUser(results[0].user.id, REVIEW_PHONE);

    const users = await userRepository.find({ where: { phone: REVIEW_PHONE } });
    expect(users).toHaveLength(1);
  });

  it('OTP alone never authenticates even when enabled', async () => {
    enableReviewLogin();

    await expect(
      authService.verifyMsg91({
        phone: '9888888888',
        otp: REVIEW_OTP,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('send endpoint acknowledges review phone without invoking MSG91', async () => {
    enableReviewLogin();

    const result = await authService.sendMsg91Otp(REVIEW_PHONE);
    expect(result).toEqual({ success: true, message: 'OTP sent' });
    expect(verifyAccessTokenMock).not.toHaveBeenCalled();
  });

  it('MSG91 provider failure path is unchanged when accessToken is used', async () => {
    enableReviewLogin();
    verifyAccessTokenMock.mockRejectedValue(new Msg91ResponseFormatError());

    await expect(
      authService.verifyMsg91({ accessToken: 'bad-token' }),
    ).rejects.toBeInstanceOf(Msg91ResponseFormatError);
  });
});
