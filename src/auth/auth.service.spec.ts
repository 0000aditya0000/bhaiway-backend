import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { UsersModule } from '../users/users.module';
import { User } from '../users/entities/user.entity';
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import { AuthModule } from './auth.module';
import { AuthService } from './auth.service';
import { Msg91ResponseFormatError } from './errors/msg91.errors';
import { OTP_PROVIDER } from './providers/otp-provider.interface';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';

describe('AuthService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let jwtService: JwtService;
  let userRepository: Repository<User>;
  let walletRepository: Repository<Wallet>;
  let balanceRepository: Repository<WalletBalance>;
  let verifyAccessTokenMock: jest.Mock;
  const tracked: TestWalletContext[] = [];

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
    jwtService = moduleRef.get(JwtService);
    userRepository = dataSource.getRepository(User);
    walletRepository = dataSource.getRepository(Wallet);
    balanceRepository = dataSource.getRepository(WalletBalance);
  });

  afterEach(async () => {
    verifyAccessTokenMock.mockReset();
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await cleanupTestWallet(dataSource, ctx);
      }
    }
  });

  afterAll(async () => {
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  it('creates user, wallet, and zero wallet balance atomically for a new verified identity', async () => {
    const phone = `+91${Date.now().toString().slice(-10)}`;

    const result = await authService.loginOrRegisterWithVerifiedIdentity({
      phone,
      verified: true,
    });

    tracked.push({
      userId: result.user.id,
      walletId: (await walletRepository.findOneByOrFail({ userId: result.user.id }))
        .id,
      balanceId: 'pending',
      phone,
    });

    const wallet = await walletRepository.findOneByOrFail({
      userId: result.user.id,
    });
    const balance = await balanceRepository.findOneByOrFail({
      walletId: wallet.id,
    });
    tracked[tracked.length - 1].balanceId = balance.id;
    tracked[tracked.length - 1].walletId = wallet.id;

    expect(result.user.phone).toBe(phone);
    expect(result.user.phoneVerified).toBe(true);
    expect(result.accessToken).toBeTruthy();

    expect(wallet.status).toBe('ACTIVE');
    expect(balance.purchasedAvailable).toBe('0');
    expect(balance.promotionalAvailable).toBe('0');
    expect(balance.driverEarnedAvailable).toBe('0');
    expect(balance.purchasedHeld).toBe('0');
    expect(balance.promotionalHeld).toBe('0');
    expect(balance.driverEarnedHeld).toBe('0');
  });

  it('logs in an existing user without creating a duplicate', async () => {
    const phone = `+91${Date.now().toString().slice(-10)}`;

    const first = await authService.loginOrRegisterWithVerifiedIdentity({
      phone,
      verified: true,
    });
    const wallet = await walletRepository.findOneByOrFail({
      userId: first.user.id,
    });
    const balance = await balanceRepository.findOneByOrFail({
      walletId: wallet.id,
    });
    tracked.push({
      userId: first.user.id,
      walletId: wallet.id,
      balanceId: balance.id,
      phone,
    });

    const second = await authService.loginOrRegisterWithVerifiedIdentity({
      phone,
      verified: true,
    });

    expect(second.user.id).toBe(first.user.id);

    const users = await userRepository.find({ where: { phone } });
    expect(users).toHaveLength(1);

    const wallets = await walletRepository.find({
      where: { userId: first.user.id },
    });
    expect(wallets).toHaveLength(1);
  });

  it('generates a JWT whose payload contains only sub', async () => {
    const phone = `+91${Date.now().toString().slice(-10)}`;
    const result = await authService.loginOrRegisterWithVerifiedIdentity({
      phone,
      verified: true,
    });
    const wallet = await walletRepository.findOneByOrFail({
      userId: result.user.id,
    });
    const balance = await balanceRepository.findOneByOrFail({
      walletId: wallet.id,
    });
    tracked.push({
      userId: result.user.id,
      walletId: wallet.id,
      balanceId: balance.id,
      phone,
    });

    const payload = jwtService.decode(result.accessToken) as Record<
      string,
      unknown
    >;

    expect(payload.sub).toBe(result.user.id);
    expect(payload.phone).toBeUndefined();
    expect(payload.walletId).toBeUndefined();
    expect(payload.otp).toBeUndefined();
  });

  it('rolls back user creation when wallet initialization fails', async () => {
    const phone = `+91${Date.now().toString().slice(-10)}`;
    const transactionSpy = jest
      .spyOn(dataSource, 'transaction')
      .mockRejectedValueOnce(new Error('Forced wallet initialization failure'));

    try {
      await expect(
        authService.loginOrRegisterWithVerifiedIdentity({
          phone,
          verified: true,
        }),
      ).rejects.toThrow('Forced wallet initialization failure');
    } finally {
      transactionSpy.mockRestore();
    }

    const users = await userRepository.find({ where: { phone } });
    expect(users).toHaveLength(0);
  });

  it('blocks MSG91 verify when provider verification fails', async () => {
    verifyAccessTokenMock.mockRejectedValue(new Msg91ResponseFormatError());

    await expect(
      authService.verifyMsg91AccessToken('any-token'),
    ).rejects.toBeInstanceOf(Msg91ResponseFormatError);
  });

  it('completes login from MSG91 verified phone and ignores client phone override', async () => {
    const phone = `91${Date.now().toString().slice(-10)}`;
    verifyAccessTokenMock.mockResolvedValue({
      phone,
      verified: true,
    });

    const result = await authService.verifyMsg91AccessToken(
      'msg91-access-token',
    );

    expect(verifyAccessTokenMock).toHaveBeenCalledWith('msg91-access-token');
    expect(result.user.phone).toBe(phone);
    expect(result.user.phoneVerified).toBe(true);
    expect(result.accessToken).toBeTruthy();

    const wallet = await walletRepository.findOneByOrFail({
      userId: result.user.id,
    });
    const balance = await balanceRepository.findOneByOrFail({
      walletId: wallet.id,
    });
    tracked.push({
      userId: result.user.id,
      walletId: wallet.id,
      balanceId: balance.id,
      phone,
    });

    const payload = jwtService.decode(result.accessToken) as Record<
      string,
      unknown
    >;
    expect(payload.sub).toBe(result.user.id);
    expect(payload.phone).toBeUndefined();

    const second = await authService.verifyMsg91AccessToken(
      'msg91-access-token',
    );
    expect(second.user.id).toBe(result.user.id);

    const users = await userRepository.find({ where: { phone } });
    expect(users).toHaveLength(1);
  });
});
