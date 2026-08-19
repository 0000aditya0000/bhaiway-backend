import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { UsersModule } from '../users/users.module';
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

const TWELVE_DAYS_SECONDS = 12 * 24 * 60 * 60;

describe('Auth JWT session lifetime (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let jwtService: JwtService;
  const otpProvider = {
    verifyAccessToken: jest
      .fn()
      .mockRejectedValue(new Msg91ResponseFormatError()),
  };
  const tracked: TestWalletContext[] = [];

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.DATABASE_URL);
    process.env.JWT_ACCESS_EXPIRES_IN = '12d';

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
      .useValue(otpProvider)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    dataSource = moduleRef.get(DataSource);
    authService = moduleRef.get(AuthService);
    jwtService = moduleRef.get(JwtService);
  });

  afterEach(async () => {
    otpProvider.verifyAccessToken.mockClear();
    while (tracked.length > 0) {
      const ctx = tracked.pop();
      if (ctx) {
        await cleanupTestWallet(dataSource, ctx);
      }
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  async function loginUser() {
    const phone = `+91${Date.now().toString().slice(-10)}`;
    const result = await authService.loginOrRegisterWithVerifiedIdentity({
      phone,
      verified: true,
    });

    const wallet = await dataSource.getRepository(Wallet).findOneByOrFail({
      userId: result.user.id,
    });
    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });

    tracked.push({
      userId: result.user.id,
      walletId: wallet.id,
      balanceId: balance.id,
      phone,
    });

    return result;
  }

  it('issues a JWT expiring approximately 12 days after login', async () => {
    const before = Math.floor(Date.now() / 1000);
    const login = await loginUser();

    const payload = jwtService.decode(login.accessToken) as {
      sub: string;
      exp: number;
      iat: number;
    };

    expect(payload.sub).toBe(login.user.id);
    expect(payload.exp - before).toBeGreaterThanOrEqual(TWELVE_DAYS_SECONDS - 5);
    expect(payload.exp - before).toBeLessThanOrEqual(TWELVE_DAYS_SECONDS + 5);
  });

  it('GET /users/me works with a newly issued JWT without calling MSG91', async () => {
    const login = await loginUser();
    otpProvider.verifyAccessToken.mockClear();

    const response = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(response.body.user.id).toBe(login.user.id);
    expect(otpProvider.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejects expired JWTs with 401', async () => {
    const login = await loginUser();
    const expiredToken = await jwtService.signAsync(
      { sub: login.user.id },
      {
        secret: process.env.JWT_ACCESS_SECRET,
        expiresIn: '1ms',
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${expiredToken}`)
      .expect(401);
  });

  it('does not call MSG91 when restoring session via stored JWT', async () => {
    const login = await loginUser();
    otpProvider.verifyAccessToken.mockClear();

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(otpProvider.verifyAccessToken).not.toHaveBeenCalled();
  });
});
