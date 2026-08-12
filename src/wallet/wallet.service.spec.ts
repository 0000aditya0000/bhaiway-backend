import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { UsersModule } from '../users/users.module';
import { WalletHoldType } from './entities/wallet-hold.entity';
import { WalletBalance } from './entities/wallet-balance.entity';
import { WalletHold } from './entities/wallet-hold.entity';
import { WalletHoldAllocation } from './entities/wallet-hold-allocation.entity';
import {
  WalletPointLot,
  WalletPointSource,
} from './entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';
import {
  InsufficientWalletBalanceError,
  WalletHoldAlreadyConsumedError,
  WalletHoldAlreadyReleasedError,
} from './errors/wallet.errors';
import {
  assertSafeTestDatabaseUrl,
  cleanupTestWallet,
  createTestWallet,
  getBalance,
  getLots,
  sumLotAmounts,
  TestWalletContext,
  uniqueIdempotencyKey,
} from './test/wallet-test.helpers';
import { WalletModule } from './wallet.module';
import { WalletService } from './wallet.service';

describe('WalletService (PostgreSQL integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let walletService: WalletService;
  let balanceRepository: Repository<WalletBalance>;
  let lotRepository: Repository<WalletPointLot>;
  let holdRepository: Repository<WalletHold>;
  let allocationRepository: Repository<WalletHoldAllocation>;
  let transactionRepository: Repository<WalletTransaction>;

  const tracked: TestWalletContext[] = [];

  async function spawnWallet(): Promise<TestWalletContext> {
    const ctx = await createTestWallet(dataSource);
    tracked.push(ctx);
    return ctx;
  }

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
        UsersModule,
        WalletModule,
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    walletService = moduleRef.get(WalletService);
    balanceRepository = dataSource.getRepository(WalletBalance);
    lotRepository = dataSource.getRepository(WalletPointLot);
    holdRepository = dataSource.getRepository(WalletHold);
    allocationRepository = dataSource.getRepository(WalletHoldAllocation);
    transactionRepository = dataSource.getRepository(WalletTransaction);

    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }
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
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  describe('credit points', () => {
    it('credits purchased points and creates lot + ledger', async () => {
      const ctx = await spawnWallet();
      const testId = uniqueIdempotencyKey('ref');
      const idempotencyKey = uniqueIdempotencyKey('credit-purchased');

      const result = await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PURCHASED,
        referenceType: 'TEST',
        referenceId: testId,
        idempotencyKey,
      });

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('100');
      expect(balance.promotionalAvailable).toBe('0');
      expect(balance.driverEarnedAvailable).toBe('0');
      expect(balance.purchasedHeld).toBe('0');
      expect(balance.promotionalHeld).toBe('0');
      expect(balance.driverEarnedHeld).toBe('0');

      const lots = await getLots(lotRepository, ctx.walletId);
      expect(lots).toHaveLength(1);
      expect(lots[0].sourceType).toBe(WalletPointSource.PURCHASED);
      expect(lots[0].originalAmount).toBe('100');
      expect(lots[0].availableAmount).toBe('100');
      expect(lots[0].heldAmount).toBe('0');

      const txs = await transactionRepository.find({
        where: { idempotencyKey },
      });
      expect(txs).toHaveLength(1);
      expect(txs[0].direction).toBe(WalletTransactionDirection.CREDIT);
      expect(txs[0].transactionType).toBe(WalletTransactionType.POINT_PURCHASE);
      expect(txs[0].amount).toBe('100');
      expect(txs[0].balanceBefore).toBe('0');
      expect(txs[0].balanceAfter).toBe('100');
      expect(result.transaction.id).toBe(txs[0].id);
    });

    it('credits promotional points', async () => {
      const ctx = await spawnWallet();
      const idempotencyKey = uniqueIdempotencyKey('credit-promo');

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 50n,
        sourceType: WalletPointSource.PROMOTIONAL,
        idempotencyKey,
      });

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.promotionalAvailable).toBe('50');

      const lots = await getLots(lotRepository, ctx.walletId);
      expect(lots).toHaveLength(1);
      expect(lots[0].sourceType).toBe(WalletPointSource.PROMOTIONAL);
      expect(lots[0].originalAmount).toBe('50');
      expect(lots[0].availableAmount).toBe('50');

      const tx = await transactionRepository.findOneByOrFail({
        idempotencyKey,
      });
      expect(tx.transactionType).toBe(WalletTransactionType.PROMOTIONAL_CREDIT);
      expect(tx.direction).toBe(WalletTransactionDirection.CREDIT);
      expect(tx.amount).toBe('50');
    });

    it('credits driver earned points', async () => {
      const ctx = await spawnWallet();
      const idempotencyKey = uniqueIdempotencyKey('credit-driver');

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 75n,
        sourceType: WalletPointSource.DRIVER_EARNED,
        idempotencyKey,
      });

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.driverEarnedAvailable).toBe('75');

      const tx = await transactionRepository.findOneByOrFail({
        idempotencyKey,
      });
      expect(tx.transactionType).toBe(WalletTransactionType.DRIVER_EARNING);
      expect(tx.direction).toBe(WalletTransactionDirection.CREDIT);
      expect(tx.amount).toBe('75');
    });

    it('is idempotent for repeated credit with the same key', async () => {
      const ctx = await spawnWallet();
      const idempotencyKey = uniqueIdempotencyKey('wallet-credit-test-1');

      const input = {
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey,
      };

      const first = await walletService.creditPoints(input);
      const second = await walletService.creditPoints(input);

      expect(second.transaction.id).toBe(first.transaction.id);

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('100');

      const lots = await getLots(lotRepository, ctx.walletId);
      expect(lots).toHaveLength(1);

      const txs = await transactionRepository.find({
        where: { idempotencyKey },
      });
      expect(txs).toHaveLength(1);
    });
  });

  describe('debit points', () => {
    it('debits purchased points from a lot', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('debit-setup'),
      });

      const debitKey = uniqueIdempotencyKey('debit-30');
      await walletService.debitPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 30n,
        idempotencyKey: debitKey,
      });

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('70');

      const lots = await getLots(lotRepository, ctx.walletId);
      expect(lots).toHaveLength(1);
      expect(lots[0].originalAmount).toBe('100');
      expect(lots[0].availableAmount).toBe('70');
      expect(lots[0].heldAmount).toBe('0');

      const tx = await transactionRepository.findOneByOrFail({
        idempotencyKey: debitKey,
      });
      expect(tx.transactionType).toBe(WalletTransactionType.BOOKING_PAYMENT);
      expect(tx.direction).toBe(WalletTransactionDirection.DEBIT);
      expect(tx.amount).toBe('30');
    });

    it('rejects insufficient balance without partial mutation', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 50n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('insufficient-setup'),
      });

      const debitKey = uniqueIdempotencyKey('insufficient-debit');
      await expect(
        walletService.debitPoints({
          walletId: ctx.walletId,
          userId: ctx.userId,
          amount: 100n,
          idempotencyKey: debitKey,
        }),
      ).rejects.toBeInstanceOf(InsufficientWalletBalanceError);

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('50');

      const lots = await getLots(lotRepository, ctx.walletId);
      expect(lots[0].availableAmount).toBe('50');
      expect(lots[0].heldAmount).toBe('0');

      const debitTx = await transactionRepository.findOne({
        where: { idempotencyKey: debitKey },
      });
      expect(debitTx).toBeNull();
    });

    it('consumes purchased lots FIFO by created_at', async () => {
      const ctx = await spawnWallet();

      const lotIds: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        await walletService.creditPoints({
          walletId: ctx.walletId,
          userId: ctx.userId,
          amount: 100n,
          sourceType: WalletPointSource.PURCHASED,
          idempotencyKey: uniqueIdempotencyKey(`fifo-credit-${i}`),
        });
        const lots = await getLots(lotRepository, ctx.walletId);
        lotIds.push(lots[lots.length - 1].id);
      }

      // Guarantee deterministic age ordering independent of clock resolution.
      await dataSource.query(
        `UPDATE wallet_point_lots SET created_at = $1 WHERE id = $2`,
        [new Date('2020-01-01T00:00:00.000Z'), lotIds[0]],
      );
      await dataSource.query(
        `UPDATE wallet_point_lots SET created_at = $1 WHERE id = $2`,
        [new Date('2020-01-02T00:00:00.000Z'), lotIds[1]],
      );
      await dataSource.query(
        `UPDATE wallet_point_lots SET created_at = $1 WHERE id = $2`,
        [new Date('2020-01-03T00:00:00.000Z'), lotIds[2]],
      );

      await walletService.debitPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 150n,
        idempotencyKey: uniqueIdempotencyKey('fifo-debit'),
      });

      const lot1 = await lotRepository.findOneByOrFail({ id: lotIds[0] });
      const lot2 = await lotRepository.findOneByOrFail({ id: lotIds[1] });
      const lot3 = await lotRepository.findOneByOrFail({ id: lotIds[2] });

      expect(lot1.availableAmount).toBe('0');
      expect(lot2.availableAmount).toBe('50');
      expect(lot3.availableAmount).toBe('100');
    });

    it('consumes promotional before purchased before driver earned', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PROMOTIONAL,
        idempotencyKey: uniqueIdempotencyKey('order-promo'),
      });
      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('order-purchased'),
      });
      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.DRIVER_EARNED,
        idempotencyKey: uniqueIdempotencyKey('order-driver'),
      });

      await walletService.debitPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 150n,
        idempotencyKey: uniqueIdempotencyKey('order-debit'),
      });

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.promotionalAvailable).toBe('0');
      expect(balance.purchasedAvailable).toBe('50');
      expect(balance.driverEarnedAvailable).toBe('100');

      const lots = await getLots(lotRepository, ctx.walletId);
      const promo = lots.find(
        (lot) => lot.sourceType === WalletPointSource.PROMOTIONAL,
      );
      const purchased = lots.find(
        (lot) => lot.sourceType === WalletPointSource.PURCHASED,
      );
      const driver = lots.find(
        (lot) => lot.sourceType === WalletPointSource.DRIVER_EARNED,
      );

      expect(promo?.availableAmount).toBe('0');
      expect(purchased?.availableAmount).toBe('50');
      expect(driver?.availableAmount).toBe('100');
    });
  });

  describe('holds', () => {
    it('creates an assured deposit hold', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 500n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('hold-credit'),
      });

      const holdKey = uniqueIdempotencyKey('hold-create');
      const result = await walletService.createHold({
        walletId: ctx.walletId,
        amount: 200n,
        holdType: WalletHoldType.ASSURED_DEPOSIT,
        referenceType: 'TEST_HOLD',
        referenceId: uniqueIdempotencyKey('hold-ref'),
        idempotencyKey: holdKey,
      });

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('300');
      expect(balance.purchasedHeld).toBe('200');
      expect(
        BigInt(balance.purchasedAvailable) + BigInt(balance.purchasedHeld),
      ).toBe(500n);

      expect(result.hold).toBeDefined();
      expect(result.hold!.status).toBe('ACTIVE');
      expect(result.hold!.amount).toBe('200');

      const allocations = await allocationRepository.find({
        where: { holdId: result.hold!.id },
      });
      expect(allocations).toHaveLength(1);
      expect(allocations[0].amount).toBe('200');

      const lots = await getLots(lotRepository, ctx.walletId);
      expect(lots[0].availableAmount).toBe('300');
      expect(lots[0].heldAmount).toBe('200');

      const tx = await transactionRepository.findOneByOrFail({
        idempotencyKey: holdKey,
      });
      expect(tx.transactionType).toBe(
        WalletTransactionType.ASSURED_DEPOSIT_HOLD,
      );
      expect(tx.direction).toBe(WalletTransactionDirection.DEBIT);
      expect(tx.amount).toBe('200');
    });

    it('allocates a hold across promotional then purchased lots', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PROMOTIONAL,
        idempotencyKey: uniqueIdempotencyKey('multi-promo'),
      });
      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('multi-purchased'),
      });

      const result = await walletService.createHold({
        walletId: ctx.walletId,
        amount: 150n,
        holdType: WalletHoldType.ASSURED_DEPOSIT,
        referenceType: 'TEST_HOLD',
        referenceId: uniqueIdempotencyKey('multi-ref'),
        idempotencyKey: uniqueIdempotencyKey('multi-hold'),
      });

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.promotionalAvailable).toBe('0');
      expect(balance.promotionalHeld).toBe('100');
      expect(balance.purchasedAvailable).toBe('50');
      expect(balance.purchasedHeld).toBe('50');

      const lots = await getLots(lotRepository, ctx.walletId);
      const promo = lots.find(
        (lot) => lot.sourceType === WalletPointSource.PROMOTIONAL,
      );
      const purchased = lots.find(
        (lot) => lot.sourceType === WalletPointSource.PURCHASED,
      );
      expect(promo?.availableAmount).toBe('0');
      expect(promo?.heldAmount).toBe('100');
      expect(purchased?.availableAmount).toBe('50');
      expect(purchased?.heldAmount).toBe('50');

      const allocations = await allocationRepository.find({
        where: { holdId: result.hold!.id },
      });
      expect(allocations).toHaveLength(2);

      const byLotId = new Map(
        allocations.map((allocation) => [allocation.pointLotId, allocation]),
      );
      expect(byLotId.get(promo!.id)?.amount).toBe('100');
      expect(byLotId.get(purchased!.id)?.amount).toBe('50');
    });

    it('is idempotent for createHold with the same key', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 500n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('hold-idem-credit'),
      });

      const idempotencyKey = uniqueIdempotencyKey('hold-test-1');
      const input = {
        walletId: ctx.walletId,
        amount: 200n,
        holdType: WalletHoldType.ASSURED_DEPOSIT,
        referenceType: 'TEST_HOLD',
        referenceId: uniqueIdempotencyKey('hold-idem-ref'),
        idempotencyKey,
      };

      const first = await walletService.createHold(input);
      const second = await walletService.createHold(input);

      expect(second.transaction.id).toBe(first.transaction.id);
      expect(second.hold?.id).toBe(first.hold?.id);

      const holds = await holdRepository.find({
        where: { walletId: ctx.walletId },
      });
      expect(holds).toHaveLength(1);

      const allocations = await allocationRepository.find({
        where: { holdId: first.hold!.id },
      });
      expect(allocations).toHaveLength(1);

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('300');
      expect(balance.purchasedHeld).toBe('200');

      const txs = await transactionRepository.find({
        where: { idempotencyKey },
      });
      expect(txs).toHaveLength(1);
    });

    it('releases a hold back to available', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 500n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('release-credit'),
      });

      const holdResult = await walletService.createHold({
        walletId: ctx.walletId,
        amount: 200n,
        holdType: WalletHoldType.ASSURED_DEPOSIT,
        referenceType: 'TEST_HOLD',
        referenceId: uniqueIdempotencyKey('release-ref'),
        idempotencyKey: uniqueIdempotencyKey('release-hold'),
      });

      const releaseKey = uniqueIdempotencyKey('release-once');
      await walletService.releaseHold({
        holdId: holdResult.hold!.id,
        idempotencyKey: releaseKey,
      });

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('500');
      expect(balance.purchasedHeld).toBe('0');

      const lots = await getLots(lotRepository, ctx.walletId);
      expect(lots[0].availableAmount).toBe('500');
      expect(lots[0].heldAmount).toBe('0');

      const hold = await holdRepository.findOneByOrFail({
        id: holdResult.hold!.id,
      });
      expect(hold.status).toBe('RELEASED');
      expect(hold.releasedAt).not.toBeNull();

      const tx = await transactionRepository.findOneByOrFail({
        idempotencyKey: releaseKey,
      });
      expect(tx.transactionType).toBe(WalletTransactionType.HOLD_RELEASE);
    });

    it('is idempotent for releaseHold', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 500n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('release-idem-credit'),
      });

      const holdResult = await walletService.createHold({
        walletId: ctx.walletId,
        amount: 200n,
        holdType: WalletHoldType.ASSURED_DEPOSIT,
        referenceType: 'TEST_HOLD',
        referenceId: uniqueIdempotencyKey('release-idem-ref'),
        idempotencyKey: uniqueIdempotencyKey('release-idem-hold'),
      });

      const releaseKey = uniqueIdempotencyKey('release-idem');
      const first = await walletService.releaseHold({
        holdId: holdResult.hold!.id,
        idempotencyKey: releaseKey,
      });
      const second = await walletService.releaseHold({
        holdId: holdResult.hold!.id,
        idempotencyKey: releaseKey,
      });

      expect(second.transaction.id).toBe(first.transaction.id);

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('500');
      expect(balance.purchasedHeld).toBe('0');

      const txs = await transactionRepository.find({
        where: { idempotencyKey: releaseKey },
      });
      expect(txs).toHaveLength(1);

      const hold = await holdRepository.findOneByOrFail({
        id: holdResult.hold!.id,
      });
      expect(hold.status).toBe('RELEASED');
    });

    it('consumes a hold permanently', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 500n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('consume-credit'),
      });

      const holdResult = await walletService.createHold({
        walletId: ctx.walletId,
        amount: 200n,
        holdType: WalletHoldType.ASSURED_DEPOSIT,
        referenceType: 'TEST_HOLD',
        referenceId: uniqueIdempotencyKey('consume-ref'),
        idempotencyKey: uniqueIdempotencyKey('consume-hold'),
      });

      const consumeKey = uniqueIdempotencyKey('consume-once');
      await walletService.consumeHold({
        holdId: holdResult.hold!.id,
        idempotencyKey: consumeKey,
      });

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('300');
      expect(balance.purchasedHeld).toBe('0');

      const lots = await getLots(lotRepository, ctx.walletId);
      expect(lots[0].availableAmount).toBe('300');
      expect(lots[0].heldAmount).toBe('0');

      const hold = await holdRepository.findOneByOrFail({
        id: holdResult.hold!.id,
      });
      expect(hold.status).toBe('CONSUMED');
      expect(hold.consumedAt).not.toBeNull();

      const tx = await transactionRepository.findOneByOrFail({
        idempotencyKey: consumeKey,
      });
      expect(tx.transactionType).toBe(WalletTransactionType.HOLD_CONSUMED);
      expect(tx.direction).toBe(WalletTransactionDirection.DEBIT);
      expect(tx.amount).toBe('200');
    });

    it('is idempotent for consumeHold', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 500n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('consume-idem-credit'),
      });

      const holdResult = await walletService.createHold({
        walletId: ctx.walletId,
        amount: 200n,
        holdType: WalletHoldType.ASSURED_DEPOSIT,
        referenceType: 'TEST_HOLD',
        referenceId: uniqueIdempotencyKey('consume-idem-ref'),
        idempotencyKey: uniqueIdempotencyKey('consume-idem-hold'),
      });

      const consumeKey = uniqueIdempotencyKey('consume-idem');
      const first = await walletService.consumeHold({
        holdId: holdResult.hold!.id,
        idempotencyKey: consumeKey,
      });
      const second = await walletService.consumeHold({
        holdId: holdResult.hold!.id,
        idempotencyKey: consumeKey,
      });

      expect(second.transaction.id).toBe(first.transaction.id);

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('300');
      expect(balance.purchasedHeld).toBe('0');

      const txs = await transactionRepository.find({
        where: { idempotencyKey: consumeKey },
      });
      expect(txs).toHaveLength(1);
    });

    it('makes release and consume mutually exclusive', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 500n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('mutex-credit'),
      });

      const firstHold = await walletService.createHold({
        walletId: ctx.walletId,
        amount: 200n,
        holdType: WalletHoldType.ASSURED_DEPOSIT,
        referenceType: 'TEST_HOLD',
        referenceId: uniqueIdempotencyKey('mutex-ref-1'),
        idempotencyKey: uniqueIdempotencyKey('mutex-hold-1'),
      });

      await walletService.releaseHold({
        holdId: firstHold.hold!.id,
        idempotencyKey: uniqueIdempotencyKey('mutex-release'),
      });

      await expect(
        walletService.consumeHold({
          holdId: firstHold.hold!.id,
          idempotencyKey: uniqueIdempotencyKey('mutex-consume-fail'),
        }),
      ).rejects.toBeInstanceOf(WalletHoldAlreadyReleasedError);

      const afterInvalidConsume = await getBalance(
        balanceRepository,
        ctx.walletId,
      );
      expect(afterInvalidConsume.purchasedAvailable).toBe('500');
      expect(afterInvalidConsume.purchasedHeld).toBe('0');

      const secondHold = await walletService.createHold({
        walletId: ctx.walletId,
        amount: 200n,
        holdType: WalletHoldType.ASSURED_DEPOSIT,
        referenceType: 'TEST_HOLD',
        referenceId: uniqueIdempotencyKey('mutex-ref-2'),
        idempotencyKey: uniqueIdempotencyKey('mutex-hold-2'),
      });

      await walletService.consumeHold({
        holdId: secondHold.hold!.id,
        idempotencyKey: uniqueIdempotencyKey('mutex-consume'),
      });

      await expect(
        walletService.releaseHold({
          holdId: secondHold.hold!.id,
          idempotencyKey: uniqueIdempotencyKey('mutex-release-fail'),
        }),
      ).rejects.toBeInstanceOf(WalletHoldAlreadyConsumedError);

      const finalBalance = await getBalance(balanceRepository, ctx.walletId);
      expect(finalBalance.purchasedAvailable).toBe('300');
      expect(finalBalance.purchasedHeld).toBe('0');
    });

    it('rejects hold creation when balance is insufficient', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('hold-insufficient-credit'),
      });

      const holdKey = uniqueIdempotencyKey('hold-insufficient');
      await expect(
        walletService.createHold({
          walletId: ctx.walletId,
          amount: 200n,
          holdType: WalletHoldType.ASSURED_DEPOSIT,
          referenceType: 'TEST_HOLD',
          referenceId: uniqueIdempotencyKey('hold-insufficient-ref'),
          idempotencyKey: holdKey,
        }),
      ).rejects.toBeInstanceOf(InsufficientWalletBalanceError);

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('100');
      expect(balance.purchasedHeld).toBe('0');

      const holds = await holdRepository.find({
        where: { walletId: ctx.walletId },
      });
      expect(holds).toHaveLength(0);

      const walletAllocations = await dataSource.query(
        `SELECT a.id
         FROM wallet_hold_allocations a
         INNER JOIN wallet_holds h ON h.id = a.hold_id
         WHERE h.wallet_id = $1`,
        [ctx.walletId],
      );
      expect(walletAllocations).toHaveLength(0);

      const tx = await transactionRepository.findOne({
        where: { idempotencyKey: holdKey },
      });
      expect(tx).toBeNull();
    });
  });

  describe('concurrency', () => {
    it('applies concurrent identical credits only once', async () => {
      const ctx = await spawnWallet();
      const idempotencyKey = uniqueIdempotencyKey('concurrent-same-credit');

      const input = {
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey,
      };

      const [first, second] = await Promise.all([
        walletService.creditPoints(input),
        walletService.creditPoints(input),
      ]);

      expect(first.transaction.id).toBe(second.transaction.id);

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('100');

      const lots = await getLots(lotRepository, ctx.walletId);
      expect(lots).toHaveLength(1);

      const txs = await transactionRepository.find({
        where: { idempotencyKey },
      });
      expect(txs).toHaveLength(1);
    });

    it('applies concurrent different credits without lost updates', async () => {
      const ctx = await spawnWallet();

      await Promise.all([
        walletService.creditPoints({
          walletId: ctx.walletId,
          userId: ctx.userId,
          amount: 100n,
          sourceType: WalletPointSource.PURCHASED,
          idempotencyKey: uniqueIdempotencyKey('concurrent-a'),
        }),
        walletService.creditPoints({
          walletId: ctx.walletId,
          userId: ctx.userId,
          amount: 200n,
          sourceType: WalletPointSource.PURCHASED,
          idempotencyKey: uniqueIdempotencyKey('concurrent-b'),
        }),
      ]);

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('300');

      const lots = await getLots(lotRepository, ctx.walletId);
      expect(lots).toHaveLength(2);

      const txs = await transactionRepository.find({
        where: { walletId: ctx.walletId },
      });
      expect(txs).toHaveLength(2);
    });

    it('allows only one of two concurrent overdrafting debits', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('concurrent-debit-credit'),
      });

      const results = await Promise.allSettled([
        walletService.debitPoints({
          walletId: ctx.walletId,
          userId: ctx.userId,
          amount: 70n,
          idempotencyKey: uniqueIdempotencyKey('concurrent-debit-a'),
        }),
        walletService.debitPoints({
          walletId: ctx.walletId,
          userId: ctx.userId,
          amount: 70n,
          idempotencyKey: uniqueIdempotencyKey('concurrent-debit-b'),
        }),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(
        (rejected[0] as PromiseRejectedResult).reason,
      ).toBeInstanceOf(InsufficientWalletBalanceError);

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('30');
      expect(BigInt(balance.purchasedAvailable) >= 0n).toBe(true);
    });
  });

  describe('integrity', () => {
    it('rolls back balance and lot changes when ledger insert fails', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('rollback-credit'),
      });

      const originalSave = EntityManager.prototype.save;
      const saveSpy = jest
        .spyOn(EntityManager.prototype, 'save')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockImplementation(async function (this: EntityManager, ...args: any[]) {
          if (args[0] === WalletTransaction) {
            throw new Error('Controlled test failure before ledger commit');
          }

          return originalSave.apply(this, args as never);
        });

      const debitKey = uniqueIdempotencyKey('rollback-debit');

      try {
        await expect(
          walletService.debitPoints({
            walletId: ctx.walletId,
            userId: ctx.userId,
            amount: 30n,
            idempotencyKey: debitKey,
          }),
        ).rejects.toThrow('Controlled test failure before ledger commit');
      } finally {
        saveSpy.mockRestore();
      }

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('100');

      const lots = await getLots(lotRepository, ctx.walletId);
      expect(lots[0].availableAmount).toBe('100');
      expect(lots[0].heldAmount).toBe('0');

      const debitTx = await transactionRepository.findOne({
        where: { idempotencyKey: debitKey },
      });
      expect(debitTx).toBeNull();
    });

    it('enforces PostgreSQL CHECK constraints', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('check-credit'),
      });

      await expect(
        dataSource.query(
          `UPDATE wallet_balances
           SET purchased_available = -1
           WHERE wallet_id = $1`,
          [ctx.walletId],
        ),
      ).rejects.toThrow();

      await expect(
        dataSource.query(
          `UPDATE wallet_balances
           SET purchased_held = -1
           WHERE wallet_id = $1`,
          [ctx.walletId],
        ),
      ).rejects.toThrow();

      const lot = (await getLots(lotRepository, ctx.walletId))[0];
      await expect(
        dataSource.query(
          `UPDATE wallet_point_lots
           SET available_amount = 80, held_amount = 30
           WHERE id = $1`,
          [lot.id],
        ),
      ).rejects.toThrow();

      const balance = await getBalance(balanceRepository, ctx.walletId);
      expect(balance.purchasedAvailable).toBe('100');
      expect(balance.purchasedHeld).toBe('0');

      const refreshedLot = await lotRepository.findOneByOrFail({ id: lot.id });
      expect(refreshedLot.availableAmount).toBe('100');
      expect(refreshedLot.heldAmount).toBe('0');
    });

    it('keeps the ledger immutable and without updated_at', async () => {
      const columns: Array<{ column_name: string }> = await dataSource.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'wallet_transactions'
           AND column_name = 'updated_at'`,
      );
      expect(columns).toHaveLength(0);

      const ctx = await spawnWallet();
      const firstKey = uniqueIdempotencyKey('immutable-1');
      const secondKey = uniqueIdempotencyKey('immutable-2');

      const first = await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: firstKey,
      });

      const firstSnapshot = await transactionRepository.findOneByOrFail({
        id: first.transaction.id,
      });

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 50n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: secondKey,
      });

      const firstAfter = await transactionRepository.findOneByOrFail({
        id: first.transaction.id,
      });

      expect(firstAfter.amount).toBe(firstSnapshot.amount);
      expect(firstAfter.balanceBefore).toBe(firstSnapshot.balanceBefore);
      expect(firstAfter.balanceAfter).toBe(firstSnapshot.balanceAfter);
      expect(firstAfter.createdAt.getTime()).toBe(
        firstSnapshot.createdAt.getTime(),
      );

      const txs = await transactionRepository.find({
        where: { walletId: ctx.walletId },
        order: { createdAt: 'ASC' },
      });
      expect(txs).toHaveLength(2);
      expect(txs[0].id).toBe(first.transaction.id);
      expect(txs[1].idempotencyKey).toBe(secondKey);
    });

    it('keeps WalletBalance consistent with Point Lots after mixed operations', async () => {
      const ctx = await spawnWallet();

      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 500n,
        sourceType: WalletPointSource.PURCHASED,
        idempotencyKey: uniqueIdempotencyKey('consistency-purchased'),
      });
      await walletService.creditPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 100n,
        sourceType: WalletPointSource.PROMOTIONAL,
        idempotencyKey: uniqueIdempotencyKey('consistency-promo'),
      });
      await walletService.debitPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 150n,
        idempotencyKey: uniqueIdempotencyKey('consistency-debit-1'),
      });

      const hold = await walletService.createHold({
        walletId: ctx.walletId,
        amount: 200n,
        holdType: WalletHoldType.ASSURED_DEPOSIT,
        referenceType: 'TEST_HOLD',
        referenceId: uniqueIdempotencyKey('consistency-hold-ref'),
        idempotencyKey: uniqueIdempotencyKey('consistency-hold'),
      });

      await walletService.releaseHold({
        holdId: hold.hold!.id,
        idempotencyKey: uniqueIdempotencyKey('consistency-release'),
      });

      await walletService.debitPoints({
        walletId: ctx.walletId,
        userId: ctx.userId,
        amount: 50n,
        idempotencyKey: uniqueIdempotencyKey('consistency-debit-2'),
      });

      const balance = await getBalance(balanceRepository, ctx.walletId);
      const lots = await getLots(lotRepository, ctx.walletId);

      expect(BigInt(balance.purchasedAvailable)).toBe(
        sumLotAmounts(lots, WalletPointSource.PURCHASED, 'availableAmount'),
      );
      expect(BigInt(balance.promotionalAvailable)).toBe(
        sumLotAmounts(lots, WalletPointSource.PROMOTIONAL, 'availableAmount'),
      );
      expect(BigInt(balance.driverEarnedAvailable)).toBe(
        sumLotAmounts(lots, WalletPointSource.DRIVER_EARNED, 'availableAmount'),
      );
      expect(BigInt(balance.purchasedHeld)).toBe(
        sumLotAmounts(lots, WalletPointSource.PURCHASED, 'heldAmount'),
      );
      expect(BigInt(balance.promotionalHeld)).toBe(
        sumLotAmounts(lots, WalletPointSource.PROMOTIONAL, 'heldAmount'),
      );
      expect(BigInt(balance.driverEarnedHeld)).toBe(
        sumLotAmounts(lots, WalletPointSource.DRIVER_EARNED, 'heldAmount'),
      );
    });
  });
});
