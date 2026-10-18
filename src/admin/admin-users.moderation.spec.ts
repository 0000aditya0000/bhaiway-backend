import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { Msg91ResponseFormatError } from '../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../auth/providers/otp-provider.interface';
import { JwtPayload, JwtStrategy } from '../auth/strategies/jwt.strategy';
import { User, UserStatus } from '../users/entities/user.entity';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  createTestWallet,
  TestWalletContext,
} from '../wallet/test/wallet-test.helpers';
import {
  ADMIN_PERMISSION_USERS_MANAGE,
  ADMIN_PERMISSION_USERS_VIEW,
} from './admin.constants';
import { AdminModule } from './admin.module';
import { AdminUsersService } from './admin-users.service';
import { AdminUser } from './entities/admin-user.entity';

function asJwtPayload(token: string, jwt: JwtService): JwtPayload {
  const decoded: unknown = jwt.decode(token);
  if (typeof decoded !== 'object' || decoded === null || !('sub' in decoded)) {
    throw new Error('Invalid JWT payload in test');
  }
  const record = decoded as Record<string, unknown>;
  if (typeof record.sub !== 'string') {
    throw new Error('Invalid JWT payload in test');
  }
  return {
    sub: record.sub,
    tv: typeof record.tv === 'number' ? record.tv : undefined,
  };
}

describe('Admin users moderation (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let authService: AuthService;
  let jwtService: JwtService;
  let jwtStrategy: JwtStrategy;
  let usersService: AdminUsersService;
  const tracked: TestWalletContext[] = [];

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.DATABASE_URL);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env.test' }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: process.env.DATABASE_URL,
          autoLoadEntities: true,
          synchronize: false,
          logging: false,
        }),
        AuthModule,
        AdminModule,
      ],
    })
      .overrideProvider(OTP_PROVIDER)
      .useValue({
        sendOtp: () => {
          throw new Msg91ResponseFormatError('unused');
        },
        verifyAccessToken: () =>
          Promise.resolve({
            verified: true,
            phone: '+910000000000',
            email: null,
          }),
      })
      .compile();

    dataSource = moduleRef.get(DataSource);
    authService = moduleRef.get(AuthService);
    jwtService = moduleRef.get(JwtService);
    jwtStrategy = moduleRef.get(JwtStrategy);
    usersService = moduleRef.get(AdminUsersService);

    await dataSource.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "token_version" integer NOT NULL DEFAULT 0
    `);
    await dataSource.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "booking_restricted" boolean NOT NULL DEFAULT false
    `);
    await dataSource.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "ride_publish_restricted" boolean NOT NULL DEFAULT false
    `);
    await dataSource.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "suspension_reason" character varying(500)
    `);
    await dataSource.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "suspended_at" TIMESTAMP WITH TIME ZONE
    `);
    await dataSource.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "booking_restricted_reason" character varying(500)
    `);
    await dataSource.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "ride_publish_restricted_reason" character varying(500)
    `);
  });

  afterAll(async () => {
    for (const ctx of tracked) {
      await cleanupTestWallet(dataSource, ctx).catch(() => undefined);
    }
    await moduleRef?.close();
  });

  async function createUser(): Promise<{
    ctx: TestWalletContext;
    token: string;
    adminId: string;
  }> {
    const ctx = await createTestWallet(dataSource);
    tracked.push(ctx);
    const login = await authService.loginOrRegisterWithVerifiedIdentity({
      verified: true,
      phone: ctx.phone,
      email: null,
    });

    const adminCtx = await createTestWallet(dataSource);
    tracked.push(adminCtx);
    await dataSource.getRepository(AdminUser).save(
      dataSource.getRepository(AdminUser).create({
        userId: adminCtx.userId,
        username: `admin_${adminCtx.userId.slice(0, 8)}`,
        passwordHash: 'x',
        permissions: [
          ADMIN_PERMISSION_USERS_VIEW,
          ADMIN_PERMISSION_USERS_MANAGE,
        ],
        isActive: true,
      }),
    );

    return { ctx, token: login.accessToken, adminId: adminCtx.userId };
  }

  it('suspends user: blocks login, rejects existing JWT, bumps token version', async () => {
    const { ctx, token, adminId } = await createUser();

    const payload = asJwtPayload(token, jwtService);
    expect(payload.tv).toBe(0);
    await expect(jwtStrategy.validate(payload)).resolves.toEqual({
      userId: ctx.userId,
    });

    await usersService.suspend(adminId, ctx.userId, {
      reason: 'Policy violation test',
    });

    const suspended = await dataSource.getRepository(User).findOneOrFail({
      where: { id: ctx.userId },
    });
    expect(suspended.status).toBe(UserStatus.SUSPENDED);
    expect(suspended.tokenVersion).toBe(1);

    await expect(jwtStrategy.validate(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    await expect(
      authService.loginOrRegisterWithVerifiedIdentity({
        verified: true,
        phone: ctx.phone,
        email: null,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('unsuspend restores login but old tokens stay revoked', async () => {
    const { ctx, token, adminId } = await createUser();
    const oldPayload = asJwtPayload(token, jwtService);

    await usersService.suspend(adminId, ctx.userId, {
      reason: 'Temporary hold',
    });
    await usersService.unsuspend(adminId, ctx.userId);

    const user = await dataSource.getRepository(User).findOneOrFail({
      where: { id: ctx.userId },
    });
    expect(user.status).toBe(UserStatus.ACTIVE);
    expect(user.tokenVersion).toBe(2);

    await expect(jwtStrategy.validate(oldPayload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    const login = await authService.loginOrRegisterWithVerifiedIdentity({
      verified: true,
      phone: ctx.phone,
      email: null,
    });
    const newPayload = asJwtPayload(login.accessToken, jwtService);
    expect(newPayload.tv).toBe(2);
    await expect(jwtStrategy.validate(newPayload)).resolves.toEqual({
      userId: ctx.userId,
    });
  });

  it('sets booking and publish restrictions independently', async () => {
    const { ctx, adminId } = await createUser();

    await usersService.restrictBooking(adminId, ctx.userId, {
      reason: 'Chargebacks',
    });
    let user = await dataSource.getRepository(User).findOneOrFail({
      where: { id: ctx.userId },
    });
    expect(user.bookingRestricted).toBe(true);
    expect(user.ridePublishRestricted).toBe(false);

    await usersService.restrictRidePublishing(adminId, ctx.userId, {
      reason: 'Unsafe vehicle',
    });
    user = await dataSource.getRepository(User).findOneOrFail({
      where: { id: ctx.userId },
    });
    expect(user.bookingRestricted).toBe(true);
    expect(user.ridePublishRestricted).toBe(true);

    await usersService.clearBookingRestriction(adminId, ctx.userId);
    user = await dataSource.getRepository(User).findOneOrFail({
      where: { id: ctx.userId },
    });
    expect(user.bookingRestricted).toBe(false);
    expect(user.ridePublishRestricted).toBe(true);
  });

  it('lists users with pagination and excludes system identities', async () => {
    const { ctx } = await createUser();
    const page = await usersService.list({ page: 1, limit: 50 });
    expect(page.items.some((i) => i.id === ctx.userId)).toBe(true);
    expect(page.summary.totalUsers).toBeGreaterThan(0);
    expect(
      page.items.every(
        (i) =>
          i.id !== '00000000-0000-4000-8000-000000000001' &&
          i.id !== '00000000-0000-4000-8000-000000000099',
      ),
    ).toBe(true);
    expect(page.items[0]?.phoneMasked).toMatch(/\*{4,}\d{4}$/);
  });
});
