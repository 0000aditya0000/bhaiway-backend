import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AdminWithdrawalsController } from '../../admin/admin-withdrawals.controller';
import { ADMIN_PERMISSION_WITHDRAWALS_MANAGE } from '../../admin/admin.constants';
import { AdminUser } from '../../admin/entities/admin-user.entity';
import { AdminPermissionGuard } from '../../admin/guards/admin-permission.guard';
import { AuthModule } from '../../auth/auth.module';
import { Msg91ResponseFormatError } from '../../auth/errors/msg91.errors';
import { OTP_PROVIDER } from '../../auth/providers/otp-provider.interface';
import { UsersModule } from '../../users/users.module';
import { WalletBalance } from '../entities/wallet-balance.entity';
import { WalletPointSource } from '../entities/wallet-point-lot.entity';
import { Withdrawal } from '../entities/withdrawal.entity';
import { WalletModule } from '../wallet.module';
import { WalletService } from '../wallet.service';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  createTestWallet,
  TestWalletContext,
  uniqueIdempotencyKey,
} from './wallet-test.helpers';

/** Minimal admin surface (avoids Redis/tracking deps of the full AdminModule). */
@Module({
  imports: [AuthModule, WalletModule, TypeOrmModule.forFeature([AdminUser])],
  controllers: [AdminWithdrawalsController],
  providers: [AdminPermissionGuard],
})
export class TestAdminWithdrawalsModule {}

export interface WithdrawalTestEnv {
  app: INestApplication;
  moduleRef: TestingModule;
  dataSource: DataSource;
  jwtService: JwtService;
  walletService: WalletService;
}

export async function createWithdrawalTestEnv(): Promise<WithdrawalTestEnv> {
  assertSafeTestDatabaseUrl(process.env.DATABASE_URL);

  const moduleRef = await Test.createTestingModule({
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
      UsersModule,
      WalletModule,
      TestAdminWithdrawalsModule,
    ],
  })
    .overrideProvider(OTP_PROVIDER)
    .useValue({
      verifyAccessToken: jest
        .fn()
        .mockRejectedValue(new Msg91ResponseFormatError()),
    })
    .compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();

  return {
    app,
    moduleRef,
    dataSource: moduleRef.get(DataSource),
    jwtService: moduleRef.get(JwtService),
    walletService: moduleRef.get(WalletService),
  };
}

export function bearer(jwtService: JwtService, userId: string): string {
  return `Bearer ${jwtService.sign({ sub: userId })}`;
}

export async function fundWallet(
  walletService: WalletService,
  ctx: TestWalletContext,
  sourceType: WalletPointSource,
  amount: bigint,
): Promise<void> {
  await walletService.creditPoints({
    walletId: ctx.walletId,
    userId: ctx.userId,
    amount,
    sourceType,
    idempotencyKey: uniqueIdempotencyKey(`fund-${sourceType.toLowerCase()}`),
  });
}

export async function createAdminFor(
  dataSource: DataSource,
  userId: string,
  permissions: string[] = [ADMIN_PERMISSION_WITHDRAWALS_MANAGE],
): Promise<AdminUser> {
  const repo = dataSource.getRepository(AdminUser);
  return repo.save(
    repo.create({
      userId,
      username: null,
      passwordHash: null,
      permissions,
      isActive: true,
    }),
  );
}

export async function readBalance(
  dataSource: DataSource,
  walletId: string,
): Promise<WalletBalance> {
  return dataSource.getRepository(WalletBalance).findOneByOrFail({ walletId });
}

/** Removes withdrawals/payment methods/admin rows before the shared wallet cleanup. */
export async function cleanupWithdrawalTestWallet(
  dataSource: DataSource,
  ctx: TestWalletContext,
): Promise<void> {
  await dataSource.getRepository(Withdrawal).delete({ walletId: ctx.walletId });
  await dataSource.getRepository(AdminUser).delete({ userId: ctx.userId });
  await dataSource.query(`DELETE FROM "user_payment_methods" WHERE "user_id" = $1`, [
    ctx.userId,
  ]);
  await cleanupTestWallet(dataSource, ctx);
}

export { createTestWallet };
