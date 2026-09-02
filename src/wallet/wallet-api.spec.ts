import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { UsersModule } from '../users/users.module';
import { WalletBalance } from './entities/wallet-balance.entity';
import {
  WalletPointSource,
} from './entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';
import { Wallet, WalletStatus } from './entities/wallet.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  createTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from './test/wallet-test.helpers';
import { pointsToCoins } from './wallet-coins.mapper';
import { WalletModule } from './wallet.module';
import { WalletService } from './wallet.service';

describe('Wallet API (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let jwtService: JwtService;
  let walletService: WalletService;
  const tracked: TestWalletContext[] = [];

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
    walletService = moduleRef.get(WalletService);
  });

  afterEach(async () => {
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
  });

  async function spawnWallet(): Promise<TestWalletContext> {
    const ctx = await createTestWallet(dataSource);
    tracked.push(ctx);
    return ctx;
  }

  function bearerToken(userId: string): string {
    return jwtService.sign({ sub: userId });
  }

  async function createAuthenticatedUser() {
    const phone = `+91${Date.now().toString().slice(-10)}${Math.floor(
      Math.random() * 10,
    )}`;
    const login = await authService.loginOrRegisterWithVerifiedIdentity({
      phone,
      verified: true,
    });
    const wallet = await dataSource.getRepository(Wallet).findOneByOrFail({
      userId: login.user.id,
    });
    const balance = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: wallet.id });

    tracked.push({
      userId: login.user.id,
      walletId: wallet.id,
      balanceId: balance.id,
      phone,
    });

    return login;
  }

  describe('authentication', () => {
    it('GET /wallet without JWT → 401', async () => {
      await request(app.getHttpServer()).get('/wallet').expect(401);
    });

    it('GET /wallet/transactions without JWT → 401', async () => {
      await request(app.getHttpServer())
        .get('/wallet/transactions')
        .expect(401);
    });
  });

  describe('GET /wallet', () => {
    it('returns zero balances for empty wallet', async () => {
      const login = await createAuthenticatedUser();

      const response = await request(app.getHttpServer())
        .get('/wallet')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(response.body).toEqual({
        balanceCoins: '0',
        availableCoins: '0',
        heldCoins: '0',
        withdrawableCoins: '0',
        nonWithdrawableCoins: '0',
        buckets: {
          purchased: { availableCoins: '0', heldCoins: '0' },
          promotional: { availableCoins: '0', heldCoins: '0' },
          driverEarned: { availableCoins: '0', heldCoins: '0' },
        },
      });
    });

    it('calculates multi-bucket balance correctly', async () => {
      const ctx = await spawnWallet();
      const balanceRepo = dataSource.getRepository(WalletBalance);

      await balanceRepo.update(
        { walletId: ctx.walletId },
        {
          purchasedAvailable: '500',
          purchasedHeld: '100',
          promotionalAvailable: '200',
          promotionalHeld: '50',
          driverEarnedAvailable: '100',
          driverEarnedHeld: '50',
        },
      );

      const response = await request(app.getHttpServer())
        .get('/wallet')
        .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
        .expect(200);

      expect(response.body).toEqual({
        balanceCoins: '1000',
        availableCoins: '800',
        heldCoins: '200',
        withdrawableCoins: '100',
        nonWithdrawableCoins: '700',
        buckets: {
          purchased: { availableCoins: '500', heldCoins: '100' },
          promotional: { availableCoins: '200', heldCoins: '50' },
          driverEarned: { availableCoins: '100', heldCoins: '50' },
        },
      });
    });

    it('maps points to coins as exact integer strings', () => {
      expect(pointsToCoins('500')).toBe('500');
      expect(pointsToCoins('0')).toBe('0');
      expect(pointsToCoins(999n)).toBe('999');
    });

    it('allows read access for SUSPENDED wallet', async () => {
      const ctx = await spawnWallet();
      await dataSource.getRepository(Wallet).update(ctx.walletId, {
        status: WalletStatus.SUSPENDED,
      });

      const response = await request(app.getHttpServer())
        .get('/wallet')
        .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
        .expect(200);

      expect(response.body.balanceCoins).toBe('0');
    });

    it('does not mutate wallet state', async () => {
      const ctx = await spawnWallet();
      const balanceRepo = dataSource.getRepository(WalletBalance);
      const txRepo = dataSource.getRepository(WalletTransaction);

      const beforeBalance = await balanceRepo.findOneByOrFail({
        walletId: ctx.walletId,
      });
      const txCountBefore = await txRepo.count({
        where: { walletId: ctx.walletId },
      });

      await request(app.getHttpServer())
        .get('/wallet')
        .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
        .expect(200);

      const afterBalance = await balanceRepo.findOneByOrFail({
        walletId: ctx.walletId,
      });
      const txCountAfter = await txRepo.count({
        where: { walletId: ctx.walletId },
      });

      expect(afterBalance).toEqual(beforeBalance);
      expect(txCountAfter).toBe(txCountBefore);
    });

    it('user only sees own wallet (isolation)', async () => {
      const userA = await spawnWallet();
      const userB = await spawnWallet();

      await dataSource.getRepository(WalletBalance).update(
        { walletId: userA.walletId },
        { purchasedAvailable: '999' },
      );
      await dataSource.getRepository(WalletBalance).update(
        { walletId: userB.walletId },
        { purchasedAvailable: '111' },
      );

      const responseA = await request(app.getHttpServer())
        .get('/wallet')
        .set('Authorization', `Bearer ${bearerToken(userA.userId)}`)
        .expect(200);

      const responseB = await request(app.getHttpServer())
        .get('/wallet')
        .set('Authorization', `Bearer ${bearerToken(userB.userId)}`)
        .expect(200);

      expect(responseA.body.buckets.purchased.availableCoins).toBe('999');
      expect(responseB.body.buckets.purchased.availableCoins).toBe('111');
    });
  });

  describe('GET /wallet/transactions', () => {
    async function seedTransactions(ctx: TestWalletContext, count: number) {
      for (let i = 0; i < count; i++) {
        await walletService.creditPoints({
          walletId: ctx.walletId,
          userId: ctx.userId,
          amount: BigInt(i + 1),
          sourceType: WalletPointSource.PURCHASED,
          idempotencyKey: uniqueIdempotencyKey(`tx-${i}`),
        });
      }
    }

    it('returns empty page for wallet with no transactions', async () => {
      const login = await createAuthenticatedUser();

      const response = await request(app.getHttpServer())
        .get('/wallet/transactions')
        .set('Authorization', `Bearer ${login.accessToken}`)
        .expect(200);

      expect(response.body).toEqual({
        items: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
    });

    it('returns transactions newest first', async () => {
      const ctx = await spawnWallet();
      await seedTransactions(ctx, 3);

      const response = await request(app.getHttpServer())
        .get('/wallet/transactions')
        .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
        .expect(200);

      expect(response.body.items).toHaveLength(3);
      const amounts = response.body.items.map(
        (item: { amount: string }) => item.amount,
      );
      expect(amounts).toEqual(['3', '2', '1']);
      expect(response.body.items[0].transactionType).toBe(
        WalletTransactionType.POINT_PURCHASE,
      );
      expect(response.body.items[0].displayTitle).toBe('Wallet top-up');
      expect(response.body.items[0].displayCategory).toBe('TOP_UP');
    });

    it('paginates results', async () => {
      const ctx = await spawnWallet();
      await seedTransactions(ctx, 5);

      const page1 = await request(app.getHttpServer())
        .get('/wallet/transactions?page=1&limit=2')
        .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
        .expect(200);

      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.page).toBe(1);
      expect(page1.body.limit).toBe(2);
      expect(page1.body.total).toBe(5);
      expect(page1.body.totalPages).toBe(3);

      const page2 = await request(app.getHttpServer())
        .get('/wallet/transactions?page=2&limit=2')
        .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
        .expect(200);

      expect(page2.body.items).toHaveLength(2);
      expect(page2.body.items.map((i: { amount: string }) => i.amount)).toEqual([
        '3',
        '2',
      ]);
    });

    it('rejects limit above 50', async () => {
      const ctx = await spawnWallet();

      await request(app.getHttpServer())
        .get('/wallet/transactions?limit=51')
        .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
        .expect(400);
    });

    it('filters by transactionType', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('purchased'),
      });
      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 50n,
        sourceType: WalletPointSource.PROMOTIONAL,
        idempotencyKey: uniqueIdempotencyKey('promo'),
      });

      const response = await request(app.getHttpServer())
        .get(
          `/wallet/transactions?transactionType=${WalletTransactionType.PROMOTIONAL_CREDIT}`,
        )
        .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
        .expect(200);

      expect(response.body.total).toBe(1);
      expect(response.body.items[0].amount).toBe('50');
      expect(response.body.items[0].transactionType).toBe(
        WalletTransactionType.PROMOTIONAL_CREDIT,
      );
    });

    it('filters by date range', async () => {
      const ctx = await spawnWallet();
      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 10n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('date-a'),
      });
      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 20n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('date-b'),
      });

      const txs = await dataSource.getRepository(WalletTransaction).find({
        where: { walletId: ctx.walletId },
        order: { createdAt: 'ASC' },
      });
      const txRepo = dataSource.getRepository(WalletTransaction);
      await txRepo.update(txs[0].id, {
        createdAt: new Date('2026-08-01T12:00:00.000Z'),
      });
      await txRepo.update(txs[1].id, {
        createdAt: new Date('2026-08-15T12:00:00.000Z'),
      });

      const response = await request(app.getHttpServer())
        .get('/wallet/transactions?from=2026-08-10&to=2026-08-20')
        .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
        .expect(200);

      expect(response.body.total).toBe(1);
      expect(response.body.items[0].amount).toBe('20');
    });

    it('user only sees own transactions (isolation)', async () => {
      const userA = await spawnWallet();
      const userB = await spawnWallet();

      await walletService.creditPoints({
        walletId: userA.walletId,
        userId: userA.userId,
        amount: 777n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('user-a'),
      });

      const responseB = await request(app.getHttpServer())
        .get('/wallet/transactions')
        .set('Authorization', `Bearer ${bearerToken(userB.userId)}`)
        .expect(200);

      expect(responseB.body.total).toBe(0);
      expect(responseB.body.items).toEqual([]);
    });

    it('does not mutate wallet state', async () => {
      const ctx = await spawnWallet();
      await seedTransactions(ctx, 2);

      const balanceRepo = dataSource.getRepository(WalletBalance);
      const txRepo = dataSource.getRepository(WalletTransaction);

      const beforeBalance = await balanceRepo.findOneByOrFail({
        walletId: ctx.walletId,
      });
      const txCountBefore = await txRepo.count({
        where: { walletId: ctx.walletId },
      });

      await request(app.getHttpServer())
        .get('/wallet/transactions')
        .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
        .expect(200);

      const afterBalance = await balanceRepo.findOneByOrFail({
        walletId: ctx.walletId,
      });
      const txCountAfter = await txRepo.count({
        where: { walletId: ctx.walletId },
      });

      expect(afterBalance).toEqual(beforeBalance);
      expect(txCountAfter).toBe(txCountBefore);
    });

    it('exposes held-wallet transaction amounts as integer coin strings', async () => {
      const ctx = await spawnWallet();
      await dataSource.getRepository(WalletBalance).update(
        { walletId: ctx.walletId },
        {
          purchasedAvailable: '400',
          purchasedHeld: '100',
        },
      );
      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('held-read'),
      });

      const balance = await request(app.getHttpServer())
        .get('/wallet')
        .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
        .expect(200);

      expect(balance.body.heldCoins).toBe('100');

      const history = await request(app.getHttpServer())
        .get('/wallet/transactions')
        .set('Authorization', `Bearer ${bearerToken(ctx.userId)}`)
        .expect(200);

      expect(history.body.items[0].amount).toBe('100');
      expect(history.body.items[0].balanceBefore).toMatch(/^\d+$/);
      expect(history.body.items[0].balanceAfter).toMatch(/^\d+$/);
    });
  });
});
