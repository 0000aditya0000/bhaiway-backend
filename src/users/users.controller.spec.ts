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
import { WalletBalance } from '../wallet/entities/wallet-balance.entity';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { RatingsModule } from '../ratings/ratings.module';
import { WalletModule } from '../wallet/wallet.module';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';
import { Gender } from './entities/user-profile.entity';
import { User } from './entities/user.entity';
import { UsersModule } from './users.module';

describe('UsersController (integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let jwtService: JwtService;
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
        RatingsModule,
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

  it('GET /users/me without JWT → 401', async () => {
    await request(app.getHttpServer()).get('/users/me').expect(401);
  });

  it('GET /users/me with valid JWT → returns user', async () => {
    const login = await createAuthenticatedUser();

    const response = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(response.body.user).toEqual({
      id: login.user.id,
      phone: login.user.phone,
      phoneVerified: true,
      email: null,
      emailVerified: false,
      status: 'ACTIVE',
    });
    expect(response.body.profile).toBeNull();
    expect(response.body.profileCompleted).toBe(false);
    expect(response.body.wallet).toMatchObject({
      balanceCoins: '0',
      availableCoins: '0',
      heldCoins: '0',
    });
    expect(response.body.driverEarnings).toEqual({
      regularTotalCoins: '0',
      assuredTotalCoins: '0',
      commuteTotalCoins: '0',
      totalCoins: '0',
    });
    expect(response.body.ratings).toEqual({
      overall: { averageRating: 0, totalRatings: 0 },
      asDriver: { averageRating: 0, totalRatings: 0 },
      asRider: { averageRating: 0, totalRatings: 0 },
    });
  });

  it('GET /users/me when profile does not exist → profile null', async () => {
    const login = await createAuthenticatedUser();

    const response = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(response.body.profile).toBeNull();
    expect(response.body.profileCompleted).toBe(false);
  });

  it('creates profile successfully', async () => {
    const login = await createAuthenticatedUser();

    const created = await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        firstName: 'Aditya',
        lastName: 'Gangwar',
        displayName: 'Aditya',
        gender: Gender.MALE,
        dateOfBirth: '2000-01-01',
        profilePhoto: 'https://cdn.example.com/a.jpg',
      })
      .expect(201);

    expect(created.body).toMatchObject({
      firstName: 'Aditya',
      lastName: 'Gangwar',
      displayName: 'Aditya',
      gender: Gender.MALE,
      dateOfBirth: '2000-01-01',
      profilePhoto: 'https://cdn.example.com/a.jpg',
    });
    expect(created.body.id).toBeTruthy();
  });

  it('create profile without JWT → 401', async () => {
    await request(app.getHttpServer())
      .post('/users/profile')
      .send({ firstName: 'Ada' })
      .expect(401);
  });

  it('duplicate profile → 409', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada' })
      .expect(409);
  });

  it('updates profile successfully', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada', lastName: 'Lovelace' })
      .expect(201);

    const updated = await request(app.getHttpServer())
      .patch('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        displayName: 'Ada L',
        gender: Gender.FEMALE,
      })
      .expect(200);

    expect(updated.body.displayName).toBe('Ada L');
    expect(updated.body.gender).toBe(Gender.FEMALE);
    expect(updated.body.firstName).toBe('Ada');
    expect(updated.body.lastName).toBe('Lovelace');
  });

  it('updates only selected fields', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        firstName: 'Ada',
        lastName: 'Lovelace',
        displayName: 'Original',
      })
      .expect(201);

    const updated = await request(app.getHttpServer())
      .patch('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ displayName: 'Updated' })
      .expect(200);

    expect(updated.body.displayName).toBe('Updated');
    expect(updated.body.firstName).toBe('Ada');
    expect(updated.body.lastName).toBe('Lovelace');
  });

  it('user cannot modify phone via profile endpoints', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada', phone: '+919999999999' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada' })
      .expect(201);

    await request(app.getHttpServer())
      .patch('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ phone: '+918888888888' })
      .expect(400);

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(me.body.user.phone).toBe(login.user.phone);
  });

  it('user cannot modify phoneVerified', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada' })
      .expect(201);

    await request(app.getHttpServer())
      .patch('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ phoneVerified: false })
      .expect(400);

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(me.body.user.phoneVerified).toBe(true);
  });

  it('user cannot modify status', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada', status: 'BLOCKED' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada' })
      .expect(201);

    await request(app.getHttpServer())
      .patch('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ status: 'BLOCKED' })
      .expect(400);

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(me.body.user.status).toBe('ACTIVE');
  });

  it('user cannot modify wallet information', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada', walletId: '00000000-0000-0000-0000-000000000001' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada' })
      .expect(201);

    await request(app.getHttpServer())
      .patch('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        walletId: '00000000-0000-0000-0000-000000000001',
        purchasedAvailable: '999',
      })
      .expect(400);

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(me.body.wallet).toBeUndefined();
    expect(me.body.user).not.toHaveProperty('walletId');
  });

  it('user cannot access another user profile (no IDOR)', async () => {
    const userA = await createAuthenticatedUser();
    const userB = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .send({ firstName: 'UserB', displayName: 'Secret B' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({
        firstName: 'UserA',
        userId: userB.user.id,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ firstName: 'UserA' })
      .expect(201);

    const meA = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);

    expect(meA.body.user.id).toBe(userA.user.id);
    expect(meA.body.profile.firstName).toBe('UserA');
    expect(meA.body.profile.displayName).toBeNull();

    await request(app.getHttpServer())
      .get(`/users/${userB.user.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .get(`/users/${userB.user.id}/profile`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .patch('/users/profile')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ userId: userB.user.id, displayName: 'Hacked' })
      .expect(400);

    const meB = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .expect(200);

    expect(meB.body.profile.firstName).toBe('UserB');
    expect(meB.body.profile.displayName).toBe('Secret B');
  });

  it('invalid gender rejected', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada', gender: 'NOT_A_GENDER' })
      .expect(400);
  });

  it('invalid dateOfBirth rejected', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada', dateOfBirth: 'not-a-date' })
      .expect(400);
  });

  it('required firstName validation', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ lastName: 'Only' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: '' })
      .expect(400);
  });

  it('profileCompleted calculation', async () => {
    const login = await createAuthenticatedUser();

    const before = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(before.body.profileCompleted).toBe(false);

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Complete' })
      .expect(201);

    const after = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(after.body.profileCompleted).toBe(true);
    expect(after.body.profile.firstName).toBe('Complete');
  });

  it('creates profile with email, normalizes it, and leaves emailVerified false', async () => {
    const login = await createAuthenticatedUser();
    const trackedWallet = tracked[tracked.length - 1];
    const balanceBefore = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: trackedWallet.walletId });
    const txCountBefore = await dataSource
      .getRepository(WalletTransaction)
      .count({ where: { userId: login.user.id } });

    const created = await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        firstName: 'Aditya',
        lastName: 'Gangwar',
        email: 'Aditya@Example.com',
        gender: Gender.MALE,
      })
      .expect(201);

    expect(created.body).toMatchObject({
      firstName: 'Aditya',
      lastName: 'Gangwar',
      gender: Gender.MALE,
    });
    expect(created.body).not.toHaveProperty('email');
    expect(created.body).not.toHaveProperty('walletId');

    const user = await dataSource.getRepository(User).findOneByOrFail({
      id: login.user.id,
    });
    expect(user.email).toBe('aditya@example.com');
    expect(user.emailVerified).toBe(false);

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(me.body.profileCompleted).toBe(true);
    expect(me.body.user.email).toBe('aditya@example.com');
    expect(me.body.user.emailVerified).toBe(false);
    expect(me.body.profile.firstName).toBe('Aditya');

    const balanceAfter = await dataSource
      .getRepository(WalletBalance)
      .findOneByOrFail({ walletId: trackedWallet.walletId });
    const txCountAfter = await dataSource
      .getRepository(WalletTransaction)
      .count({ where: { userId: login.user.id } });
    expect(balanceAfter.purchasedAvailable).toBe(balanceBefore.purchasedAvailable);
    expect(txCountAfter).toBe(txCountBefore);
  });

  it('creates profile without email when omitted', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ firstName: 'Ada', lastName: 'Lovelace' })
      .expect(201);

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(me.body.user.email).toBeNull();
    expect(me.body.user.emailVerified).toBe(false);
    expect(me.body.profileCompleted).toBe(true);
  });

  it('rejects invalid email with 400', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        firstName: 'Ada',
        email: 'not-an-email',
      })
      .expect(400);
  });

  it('normalizes email with surrounding spaces', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        firstName: 'Ada',
        email: '  Ada@Example.com  ',
      })
      .expect(201);

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(me.body.user.email).toBe('ada@example.com');
    expect(me.body.user.emailVerified).toBe(false);
  });

  it('duplicate email belonging to another user returns 409', async () => {
    const first = await createAuthenticatedUser();
    const second = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${first.accessToken}`)
      .send({ firstName: 'First', email: 'shared@example.com' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${second.accessToken}`)
      .send({ firstName: 'Second', email: 'Shared@Example.com' })
      .expect(409);

    const secondUser = await dataSource.getRepository(User).findOneByOrFail({
      id: second.user.id,
    });
    expect(secondUser.email).toBeNull();
  });

  it('same user may create profile using their existing email', async () => {
    const login = await createAuthenticatedUser();
    await dataSource.getRepository(User).update(
      { id: login.user.id },
      { email: 'already@example.com', emailVerified: false },
    );

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        firstName: 'Ada',
        email: 'Already@Example.com',
      })
      .expect(201);

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);

    expect(me.body.user.email).toBe('already@example.com');
    expect(me.body.user.emailVerified).toBe(false);
    expect(me.body.profileCompleted).toBe(true);
  });

  it('rejects unknown email-related extra fields', async () => {
    const login = await createAuthenticatedUser();

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        firstName: 'Ada',
        email: 'ada@example.com',
        emailVerified: true,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/users/profile')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({
        firstName: 'Ada',
        emailAddress: 'ada@example.com',
      })
      .expect(400);
  });

  it('JWT payload used by guard contains only sub as identity claim', async () => {
    const login = await createAuthenticatedUser();
    const payload = jwtService.decode(login.accessToken) as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload).sort()).toEqual(
      expect.arrayContaining(['sub', 'iat', 'exp']),
    );
    expect(payload.sub).toBe(login.user.id);
  });
});
