import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';

import {
  ConsumeHoldInput,
  CreateHoldInput,
  CreditPointsInput,
  DebitPointsInput,
  ReleaseHoldInput,
  WalletOperationResult,
} from './dto/wallet-operation.dto';
import { WalletBalance } from './entities/wallet-balance.entity';
import { WalletHoldAllocation } from './entities/wallet-hold-allocation.entity';
import { WalletHold, WalletHoldStatus, WalletHoldType } from './entities/wallet-hold.entity';
import {
  WalletPointLot,
  WalletPointSource,
} from './entities/wallet-point-lot.entity';
import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';
import { Wallet } from './entities/wallet.entity';
import {
  InsufficientWalletBalanceError,
  InvalidWalletAmountError,
  PlatformWalletForbiddenError,
  PointLotNotFoundError,
  WalletBalanceNotFoundError,
  WalletHoldAlreadyConsumedError,
  WalletHoldAlreadyReleasedError,
  WalletHoldNotActiveError,
  WalletHoldNotFoundError,
  WalletNotFoundError,
  WalletOperationConflictError,
} from './errors/wallet.errors';
import {
  isPlatformUserId,
  isPlatformWalletId,
} from './platform-wallet.constants';

const CONSUMPTION_SOURCE_ORDER: WalletPointSource[] = [
  WalletPointSource.PROMOTIONAL,
  WalletPointSource.PURCHASED,
  WalletPointSource.DRIVER_EARNED,
];

const SOURCE_PRIORITY: Record<WalletPointSource, number> = {
  [WalletPointSource.PROMOTIONAL]: 1,
  [WalletPointSource.PURCHASED]: 2,
  [WalletPointSource.DRIVER_EARNED]: 3,
};

interface LotAllocationPlan {
  lot: WalletPointLot;
  amount: bigint;
}

@Injectable()
export class WalletService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @InjectRepository(WalletBalance)
    private readonly walletBalanceRepository: Repository<WalletBalance>,
    @InjectRepository(WalletPointLot)
    private readonly walletPointLotRepository: Repository<WalletPointLot>,
    @InjectRepository(WalletHold)
    private readonly walletHoldRepository: Repository<WalletHold>,
    @InjectRepository(WalletHoldAllocation)
    private readonly walletHoldAllocationRepository: Repository<WalletHoldAllocation>,
    @InjectRepository(WalletTransaction)
    private readonly walletTransactionRepository: Repository<WalletTransaction>,
  ) {}

  async creditPoints(input: CreditPointsInput): Promise<WalletOperationResult> {
    this.assertPositiveAmount(input.amount);

    return this.runIdempotentMutation(input.idempotencyKey, async (manager) =>
      this.creditPointsInTransaction(manager, input),
    );
  }

  /**
   * Credit points using an existing EntityManager (no nested transaction).
   */
  async creditPointsInTransaction(
    manager: EntityManager,
    input: CreditPointsInput,
  ): Promise<WalletOperationResult> {
    this.assertPositiveAmount(input.amount);
    this.assertPlatformWalletAccess(input.walletId, input.userId, input);

    const existingBeforeLock = await this.findTransactionByIdempotencyKey(
      manager,
      input.idempotencyKey,
    );
    if (existingBeforeLock) {
      return this.buildResultFromExistingTransaction(
        manager,
        existingBeforeLock,
      );
    }

    const balance = await this.lockWalletBalance(manager, input.walletId);

    const existingAfterLock = await this.findTransactionByIdempotencyKey(
      manager,
      input.idempotencyKey,
    );
    if (existingAfterLock) {
      return this.buildResultFromExistingTransaction(
        manager,
        existingAfterLock,
      );
    }

    const balanceBefore = this.getTotalBalance(balance);
    this.increaseAvailable(balance, input.sourceType, input.amount);

    const lot = manager.create(WalletPointLot, {
      walletId: input.walletId,
      sourceType: input.sourceType,
      originalAmount: this.toAmountString(input.amount),
      availableAmount: this.toAmountString(input.amount),
      heldAmount: '0',
      expiresAt: null,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
    });

    const balanceAfter = this.getTotalBalance(balance);

    const transaction = manager.create(WalletTransaction, {
      walletId: input.walletId,
      userId: input.userId,
      transactionType:
        input.transactionType ??
        this.mapCreditTransactionType(input.sourceType),
      pointSource: input.sourceType,
      direction: WalletTransactionDirection.CREDIT,
      amount: this.toAmountString(input.amount),
      balanceBefore: this.toAmountString(balanceBefore),
      balanceAfter: this.toAmountString(balanceAfter),
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      parentTransactionId: null,
      idempotencyKey: input.idempotencyKey,
      status: WalletTransactionStatus.POSTED,
    });

    await manager.save(WalletBalance, balance);
    await manager.save(WalletPointLot, lot);
    const savedTransaction = await manager.save(
      WalletTransaction,
      transaction,
    );

    return {
      transaction: savedTransaction,
      balance,
    };
  }

  async debitPoints(input: DebitPointsInput): Promise<WalletOperationResult> {
    this.assertPositiveAmount(input.amount);

    return this.runIdempotentMutation(input.idempotencyKey, async (manager) =>
      this.debitPointsInTransaction(manager, input),
    );
  }

  /**
   * Debit wallet points using an existing EntityManager.
   * Callers must own the surrounding transaction and lock ordering.
   * Does not open a nested transaction.
   */
  async debitPointsInTransaction(
    manager: EntityManager,
    input: DebitPointsInput,
  ): Promise<WalletOperationResult> {
    this.assertPositiveAmount(input.amount);
    this.assertPlatformWalletAccess(input.walletId, input.userId, input);

    const existingBeforeLock = await this.findTransactionByIdempotencyKey(
      manager,
      input.idempotencyKey,
    );
    if (existingBeforeLock) {
      return this.buildResultFromExistingTransaction(
        manager,
        existingBeforeLock,
      );
    }

    const balance = await this.lockWalletBalance(manager, input.walletId);

    const existingAfterLock = await this.findTransactionByIdempotencyKey(
      manager,
      input.idempotencyKey,
    );
    if (existingAfterLock) {
      return this.buildResultFromExistingTransaction(
        manager,
        existingAfterLock,
      );
    }

    if (this.getAvailableBalance(balance) < input.amount) {
      throw new InsufficientWalletBalanceError();
    }

    const balanceBefore = this.getTotalBalance(balance);
    const lots = await this.lockAvailablePointLots(manager, input.walletId);
    const plans = this.planLotConsumption(lots, input.amount);

    for (const plan of plans) {
      plan.lot.availableAmount = this.toAmountString(
        BigInt(plan.lot.availableAmount) - plan.amount,
      );
      this.decreaseAvailable(balance, plan.lot.sourceType, plan.amount);
      await manager.save(WalletPointLot, plan.lot);
    }

    const balanceAfter = this.getTotalBalance(balance);

    const transaction = manager.create(WalletTransaction, {
      walletId: input.walletId,
      userId: input.userId,
      transactionType:
        input.transactionType ?? WalletTransactionType.BOOKING_PAYMENT,
      pointSource: null,
      direction: WalletTransactionDirection.DEBIT,
      amount: this.toAmountString(input.amount),
      balanceBefore: this.toAmountString(balanceBefore),
      balanceAfter: this.toAmountString(balanceAfter),
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      parentTransactionId: null,
      idempotencyKey: input.idempotencyKey,
      status: WalletTransactionStatus.POSTED,
    });

    await manager.save(WalletBalance, balance);
    const savedTransaction = await manager.save(WalletTransaction, transaction);

    return {
      transaction: savedTransaction,
      balance,
    };
  }

  /**
   * True when PostgreSQL rejected an insert due to the wallet ledger
   * idempotency unique constraint (safe to resolve after full rollback).
   */
  isIdempotencyKeyConflict(error: unknown): boolean {
    return this.isIdempotencyUniqueViolation(error);
  }

  async createHold(input: CreateHoldInput): Promise<WalletOperationResult> {
    this.assertPositiveAmount(input.amount);

    return this.runIdempotentMutation(input.idempotencyKey, async (manager) =>
      this.createHoldInTransaction(manager, input),
    );
  }

  /**
   * Create an Assured deposit hold using an existing EntityManager.
   * Assured-only: holdType must be ASSURED_DEPOSIT.
   *
   * Ledger note (M1): ASSURED_DEPOSIT_HOLD is recorded as DEBIT because it
   * reduces *spendable* (available) balance. Total wallet value is unchanged
   * (available ↓, held ↑). This is a restriction, not value destruction.
   * Callers must own the surrounding transaction and lock ordering.
   */
  async createHoldInTransaction(
    manager: EntityManager,
    input: CreateHoldInput,
  ): Promise<WalletOperationResult> {
    this.assertPositiveAmount(input.amount);
    if (input.holdType !== WalletHoldType.ASSURED_DEPOSIT) {
      throw new WalletOperationConflictError(
        'createHoldInTransaction only supports ASSURED_DEPOSIT holds',
      );
    }
    this.assertPlatformWalletAccess(input.walletId, null, {
      allowPlatformOperations: false,
    });

    const existingBeforeLock = await this.findTransactionByIdempotencyKey(
      manager,
      input.idempotencyKey,
    );
    if (existingBeforeLock) {
      return this.buildResultFromExistingTransaction(
        manager,
        existingBeforeLock,
      );
    }

    const wallet = await manager.findOne(Wallet, {
      where: { id: input.walletId },
    });
    if (!wallet) {
      throw new WalletNotFoundError(input.walletId);
    }

    const balance = await this.lockWalletBalance(manager, input.walletId);

    const existingAfterLock = await this.findTransactionByIdempotencyKey(
      manager,
      input.idempotencyKey,
    );
    if (existingAfterLock) {
      return this.buildResultFromExistingTransaction(
        manager,
        existingAfterLock,
      );
    }

    if (this.getAvailableBalance(balance) < input.amount) {
      throw new InsufficientWalletBalanceError();
    }

    const balanceBefore = this.getTotalBalance(balance);
    const lots = await this.lockAvailablePointLots(manager, input.walletId);
    const plans = this.planLotConsumption(lots, input.amount);

    const hold = manager.create(WalletHold, {
      walletId: input.walletId,
      amount: this.toAmountString(input.amount),
      holdType: input.holdType,
      status: WalletHoldStatus.ACTIVE,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      expiresAt: input.expiresAt ?? null,
      releasedAt: null,
      consumedAt: null,
    });
    let savedHold: WalletHold;
    try {
      savedHold = await manager.save(WalletHold, hold);
    } catch (error) {
      if (this.isActiveHoldReferenceUniqueViolation(error)) {
        throw new WalletOperationConflictError(
          'An ACTIVE wallet hold already exists for this reference',
        );
      }
      throw error;
    }

    const allocations: WalletHoldAllocation[] = [];
    for (const plan of plans) {
      plan.lot.availableAmount = this.toAmountString(
        BigInt(plan.lot.availableAmount) - plan.amount,
      );
      plan.lot.heldAmount = this.toAmountString(
        BigInt(plan.lot.heldAmount) + plan.amount,
      );
      this.moveAvailableToHeld(balance, plan.lot.sourceType, plan.amount);
      await manager.save(WalletPointLot, plan.lot);

      allocations.push(
        manager.create(WalletHoldAllocation, {
          holdId: savedHold.id,
          pointLotId: plan.lot.id,
          amount: this.toAmountString(plan.amount),
        }),
      );
    }

    await manager.save(WalletHoldAllocation, allocations);
    await manager.save(WalletBalance, balance);

    // available -> held; total Points unchanged
    const balanceAfter = this.getTotalBalance(balance);

    const transaction = manager.create(WalletTransaction, {
      walletId: input.walletId,
      userId: wallet.userId,
      transactionType: WalletTransactionType.ASSURED_DEPOSIT_HOLD,
      pointSource: null,
      direction: WalletTransactionDirection.DEBIT,
      amount: this.toAmountString(input.amount),
      balanceBefore: this.toAmountString(balanceBefore),
      balanceAfter: this.toAmountString(balanceAfter),
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      parentTransactionId: null,
      idempotencyKey: input.idempotencyKey,
      status: WalletTransactionStatus.POSTED,
    });

    const savedTransaction = await manager.save(
      WalletTransaction,
      transaction,
    );

    return {
      transaction: savedTransaction,
      balance,
      hold: savedHold,
    };
  }

  async releaseHold(input: ReleaseHoldInput): Promise<WalletOperationResult> {
    return this.runIdempotentMutation(input.idempotencyKey, async (manager) =>
      this.releaseHoldInTransaction(manager, input),
    );
  }

  /**
   * Release an ACTIVE hold using an existing EntityManager.
   * Callers own the surrounding transaction and lock ordering.
   * Already-RELEASED holds return the existing HOLD_RELEASE result (idempotent).
   */
  async releaseHoldInTransaction(
    manager: EntityManager,
    input: ReleaseHoldInput,
  ): Promise<WalletOperationResult> {
    const existingBeforeLock = await this.findTransactionByIdempotencyKey(
      manager,
      input.idempotencyKey,
    );
    if (existingBeforeLock) {
      return this.buildResultFromExistingTransaction(
        manager,
        existingBeforeLock,
      );
    }

    const hold = await this.lockWalletHold(manager, input.holdId);

    const existingAfterHoldLock = await this.findTransactionByIdempotencyKey(
      manager,
      input.idempotencyKey,
    );
    if (existingAfterHoldLock) {
      return this.buildResultFromExistingTransaction(
        manager,
        existingAfterHoldLock,
      );
    }

    if (hold.status === WalletHoldStatus.RELEASED) {
      return this.buildResultFromExistingHoldRelease(manager, hold);
    }

    this.assertHoldActive(hold);

    const walletEntity = await manager.findOne(Wallet, {
      where: { id: hold.walletId },
    });
    if (!walletEntity) {
      throw new WalletNotFoundError(hold.walletId);
    }

    const balance = await this.lockWalletBalance(manager, hold.walletId);

    const existingAfterBalanceLock = await this.findTransactionByIdempotencyKey(
      manager,
      input.idempotencyKey,
    );
    if (existingAfterBalanceLock) {
      return this.buildResultFromExistingTransaction(
        manager,
        existingAfterBalanceLock,
      );
    }

    const balanceBefore = this.getTotalBalance(balance);

    const allocations = await this.lockHoldAllocations(manager, hold.id);
    const lots = await this.lockPointLotsByIds(
      manager,
      allocations.map((allocation) => allocation.pointLotId),
    );
    const lotsById = new Map(lots.map((lot) => [lot.id, lot]));

    for (const allocation of allocations) {
      const lot = lotsById.get(allocation.pointLotId);
      if (!lot) {
        throw new PointLotNotFoundError(allocation.pointLotId);
      }

      const amount = BigInt(allocation.amount);
      lot.heldAmount = this.toAmountString(BigInt(lot.heldAmount) - amount);
      lot.availableAmount = this.toAmountString(
        BigInt(lot.availableAmount) + amount,
      );
      this.moveHeldToAvailable(balance, lot.sourceType, amount);
      await manager.save(WalletPointLot, lot);
    }

    hold.status = WalletHoldStatus.RELEASED;
    hold.releasedAt = new Date();
    await manager.save(WalletHold, hold);
    await manager.save(WalletBalance, balance);

    const balanceAfter = this.getTotalBalance(balance);
    const parentTransaction = await this.findHoldParentTransaction(
      manager,
      hold,
    );

    const transaction = manager.create(WalletTransaction, {
      walletId: hold.walletId,
      userId: walletEntity.userId,
      transactionType: WalletTransactionType.HOLD_RELEASE,
      pointSource: null,
      direction: WalletTransactionDirection.CREDIT,
      amount: hold.amount,
      balanceBefore: this.toAmountString(balanceBefore),
      balanceAfter: this.toAmountString(balanceAfter),
      referenceType: 'wallet_hold',
      referenceId: hold.id,
      parentTransactionId: parentTransaction?.id ?? null,
      idempotencyKey: input.idempotencyKey,
      status: WalletTransactionStatus.POSTED,
    });

    const savedTransaction = await manager.save(
      WalletTransaction,
      transaction,
    );

    return {
      transaction: savedTransaction,
      balance,
      hold,
    };
  }

  async consumeHold(input: ConsumeHoldInput): Promise<WalletOperationResult> {
    return this.runIdempotentMutation(input.idempotencyKey, async (manager) =>
      this.consumeHoldInTransaction(manager, input),
    );
  }

  /**
   * Consume an ACTIVE hold using an existing EntityManager.
   * Already-CONSUMED holds return the existing HOLD_CONSUMED result (idempotent).
   */
  async consumeHoldInTransaction(
    manager: EntityManager,
    input: ConsumeHoldInput,
  ): Promise<WalletOperationResult> {
    const existingBeforeLock = await this.findTransactionByIdempotencyKey(
      manager,
      input.idempotencyKey,
    );
    if (existingBeforeLock) {
      return this.buildResultFromExistingTransaction(
        manager,
        existingBeforeLock,
      );
    }

    const hold = await this.lockWalletHold(manager, input.holdId);

    const existingAfterHoldLock = await this.findTransactionByIdempotencyKey(
      manager,
      input.idempotencyKey,
    );
    if (existingAfterHoldLock) {
      return this.buildResultFromExistingTransaction(
        manager,
        existingAfterHoldLock,
      );
    }

    if (hold.status === WalletHoldStatus.CONSUMED) {
      return this.buildResultFromExistingHoldConsume(manager, hold);
    }

    if (hold.status === WalletHoldStatus.RELEASED) {
      throw new WalletHoldAlreadyReleasedError(hold.id);
    }

    this.assertHoldActive(hold);

    const walletEntity = await manager.findOne(Wallet, {
      where: { id: hold.walletId },
    });
    if (!walletEntity) {
      throw new WalletNotFoundError(hold.walletId);
    }

    const balance = await this.lockWalletBalance(manager, hold.walletId);

    const existingAfterBalanceLock = await this.findTransactionByIdempotencyKey(
      manager,
      input.idempotencyKey,
    );
    if (existingAfterBalanceLock) {
      return this.buildResultFromExistingTransaction(
        manager,
        existingAfterBalanceLock,
      );
    }

    const balanceBefore = this.getTotalBalance(balance);

    const allocations = await this.lockHoldAllocations(manager, hold.id);
    const lots = await this.lockPointLotsByIds(
      manager,
      allocations.map((allocation) => allocation.pointLotId),
    );
    const lotsById = new Map(lots.map((lot) => [lot.id, lot]));

    for (const allocation of allocations) {
      const lot = lotsById.get(allocation.pointLotId);
      if (!lot) {
        throw new PointLotNotFoundError(allocation.pointLotId);
      }

      const amount = BigInt(allocation.amount);
      lot.heldAmount = this.toAmountString(BigInt(lot.heldAmount) - amount);
      this.decreaseHeld(balance, lot.sourceType, amount);
      await manager.save(WalletPointLot, lot);
    }

    hold.status = WalletHoldStatus.CONSUMED;
    hold.consumedAt = new Date();
    await manager.save(WalletHold, hold);
    await manager.save(WalletBalance, balance);

    const balanceAfter = this.getTotalBalance(balance);
    const parentTransaction = await this.findHoldParentTransaction(
      manager,
      hold,
    );

    const transaction = manager.create(WalletTransaction, {
      walletId: hold.walletId,
      userId: walletEntity.userId,
      transactionType: WalletTransactionType.HOLD_CONSUMED,
      pointSource: null,
      direction: WalletTransactionDirection.DEBIT,
      amount: hold.amount,
      balanceBefore: this.toAmountString(balanceBefore),
      balanceAfter: this.toAmountString(balanceAfter),
      referenceType: 'wallet_hold',
      referenceId: hold.id,
      parentTransactionId: parentTransaction?.id ?? null,
      idempotencyKey: input.idempotencyKey,
      status: WalletTransactionStatus.POSTED,
    });

    const savedTransaction = await manager.save(
      WalletTransaction,
      transaction,
    );

    return {
      transaction: savedTransaction,
      balance,
      hold,
    };
  }

  /**
   * Runs financial work in one DB transaction.
   * On idempotency unique violation the transaction fully rolls back, then a
   * fresh lookup returns the winning request's committed result.
   */
  private async runIdempotentMutation(
    idempotencyKey: string,
    work: (manager: EntityManager) => Promise<WalletOperationResult>,
  ): Promise<WalletOperationResult> {
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      if (!this.isIdempotencyUniqueViolation(error)) {
        throw error;
      }

      return this.loadExistingOperationResult(idempotencyKey);
    }
  }

  /**
   * Fresh post-rollback read path. Must not reuse a failed EntityManager.
   */
  private async loadExistingOperationResult(
    idempotencyKey: string,
  ): Promise<WalletOperationResult> {
    const transaction = await this.walletTransactionRepository.findOne({
      where: { idempotencyKey },
    });

    if (!transaction) {
      throw new WalletOperationConflictError(
        'Idempotency conflict could not be resolved; existing wallet transaction not found',
      );
    }

    const balance = await this.walletBalanceRepository.findOne({
      where: { walletId: transaction.walletId },
    });
    if (!balance) {
      throw new WalletBalanceNotFoundError(transaction.walletId);
    }

    const hold = await this.findHoldForTransaction(transaction);

    return {
      transaction,
      balance,
      hold,
    };
  }

  private async findHoldForTransaction(
    transaction: WalletTransaction,
    manager?: EntityManager,
  ): Promise<WalletHold | undefined> {
    const holdRepository = manager
      ? manager.getRepository(WalletHold)
      : this.walletHoldRepository;

    if (
      transaction.transactionType === WalletTransactionType.HOLD_RELEASE ||
      transaction.transactionType === WalletTransactionType.HOLD_CONSUMED
    ) {
      if (!transaction.referenceId) {
        return undefined;
      }

      return (
        (await holdRepository.findOne({
          where: { id: transaction.referenceId },
        })) ?? undefined
      );
    }

    if (
      transaction.transactionType === WalletTransactionType.ASSURED_DEPOSIT_HOLD
    ) {
      return (
        (await holdRepository.findOne({
          where: {
            walletId: transaction.walletId,
            referenceType: transaction.referenceType ?? undefined,
            referenceId: transaction.referenceId ?? undefined,
            amount: transaction.amount,
          },
          order: { createdAt: 'DESC' },
        })) ?? undefined
      );
    }

    return undefined;
  }

  private getTotalBalance(balance: WalletBalance): bigint {
    return (
      BigInt(balance.purchasedAvailable) +
      BigInt(balance.promotionalAvailable) +
      BigInt(balance.driverEarnedAvailable) +
      BigInt(balance.purchasedHeld) +
      BigInt(balance.promotionalHeld) +
      BigInt(balance.driverEarnedHeld)
    );
  }

  private getAvailableBalance(balance: WalletBalance): bigint {
    return (
      BigInt(balance.purchasedAvailable) +
      BigInt(balance.promotionalAvailable) +
      BigInt(balance.driverEarnedAvailable)
    );
  }

  private getHeldBalance(balance: WalletBalance): bigint {
    return (
      BigInt(balance.purchasedHeld) +
      BigInt(balance.promotionalHeld) +
      BigInt(balance.driverEarnedHeld)
    );
  }

  private assertPositiveAmount(amount: bigint): void {
    if (amount <= 0n) {
      throw new InvalidWalletAmountError();
    }
  }

  /**
   * Platform wallet/user are internal-only.
   * Normal credit/debit/hold flows must not touch PLATFORM_WALLET_ID unless
   * allowPlatformOperations is explicitly true (Assured lifecycle funding).
   */
  private assertPlatformWalletAccess(
    walletId: string,
    userId: string | null,
    options: { allowPlatformOperations?: boolean },
  ): void {
    const allowed = options.allowPlatformOperations === true;
    if (!allowed && isPlatformWalletId(walletId)) {
      throw new PlatformWalletForbiddenError();
    }
    if (!allowed && userId != null && isPlatformUserId(userId)) {
      throw new PlatformWalletForbiddenError(
        'Platform user cannot perform normal wallet operations',
      );
    }
  }

  private toAmountString(amount: bigint): string {
    return amount.toString();
  }

  private mapCreditTransactionType(
    sourceType: WalletPointSource,
  ): WalletTransactionType {
    switch (sourceType) {
      case WalletPointSource.PURCHASED:
        return WalletTransactionType.POINT_PURCHASE;
      case WalletPointSource.PROMOTIONAL:
        return WalletTransactionType.PROMOTIONAL_CREDIT;
      case WalletPointSource.DRIVER_EARNED:
        return WalletTransactionType.DRIVER_EARNING;
      default: {
        const _exhaustive: never = sourceType;
        throw new WalletOperationConflictError(
          `Unsupported point source: ${_exhaustive}`,
        );
      }
    }
  }

  private increaseAvailable(
    balance: WalletBalance,
    sourceType: WalletPointSource,
    amount: bigint,
  ): void {
    switch (sourceType) {
      case WalletPointSource.PURCHASED:
        balance.purchasedAvailable = this.toAmountString(
          BigInt(balance.purchasedAvailable) + amount,
        );
        return;
      case WalletPointSource.PROMOTIONAL:
        balance.promotionalAvailable = this.toAmountString(
          BigInt(balance.promotionalAvailable) + amount,
        );
        return;
      case WalletPointSource.DRIVER_EARNED:
        balance.driverEarnedAvailable = this.toAmountString(
          BigInt(balance.driverEarnedAvailable) + amount,
        );
        return;
      default: {
        const _exhaustive: never = sourceType;
        throw new WalletOperationConflictError(
          `Unsupported point source: ${_exhaustive}`,
        );
      }
    }
  }

  private decreaseAvailable(
    balance: WalletBalance,
    sourceType: WalletPointSource,
    amount: bigint,
  ): void {
    switch (sourceType) {
      case WalletPointSource.PURCHASED:
        balance.purchasedAvailable = this.toAmountString(
          BigInt(balance.purchasedAvailable) - amount,
        );
        return;
      case WalletPointSource.PROMOTIONAL:
        balance.promotionalAvailable = this.toAmountString(
          BigInt(balance.promotionalAvailable) - amount,
        );
        return;
      case WalletPointSource.DRIVER_EARNED:
        balance.driverEarnedAvailable = this.toAmountString(
          BigInt(balance.driverEarnedAvailable) - amount,
        );
        return;
      default: {
        const _exhaustive: never = sourceType;
        throw new WalletOperationConflictError(
          `Unsupported point source: ${_exhaustive}`,
        );
      }
    }
  }

  private decreaseHeld(
    balance: WalletBalance,
    sourceType: WalletPointSource,
    amount: bigint,
  ): void {
    switch (sourceType) {
      case WalletPointSource.PURCHASED:
        balance.purchasedHeld = this.toAmountString(
          BigInt(balance.purchasedHeld) - amount,
        );
        return;
      case WalletPointSource.PROMOTIONAL:
        balance.promotionalHeld = this.toAmountString(
          BigInt(balance.promotionalHeld) - amount,
        );
        return;
      case WalletPointSource.DRIVER_EARNED:
        balance.driverEarnedHeld = this.toAmountString(
          BigInt(balance.driverEarnedHeld) - amount,
        );
        return;
      default: {
        const _exhaustive: never = sourceType;
        throw new WalletOperationConflictError(
          `Unsupported point source: ${_exhaustive}`,
        );
      }
    }
  }

  private moveAvailableToHeld(
    balance: WalletBalance,
    sourceType: WalletPointSource,
    amount: bigint,
  ): void {
    this.decreaseAvailable(balance, sourceType, amount);
    switch (sourceType) {
      case WalletPointSource.PURCHASED:
        balance.purchasedHeld = this.toAmountString(
          BigInt(balance.purchasedHeld) + amount,
        );
        return;
      case WalletPointSource.PROMOTIONAL:
        balance.promotionalHeld = this.toAmountString(
          BigInt(balance.promotionalHeld) + amount,
        );
        return;
      case WalletPointSource.DRIVER_EARNED:
        balance.driverEarnedHeld = this.toAmountString(
          BigInt(balance.driverEarnedHeld) + amount,
        );
        return;
      default: {
        const _exhaustive: never = sourceType;
        throw new WalletOperationConflictError(
          `Unsupported point source: ${_exhaustive}`,
        );
      }
    }
  }

  private moveHeldToAvailable(
    balance: WalletBalance,
    sourceType: WalletPointSource,
    amount: bigint,
  ): void {
    this.decreaseHeld(balance, sourceType, amount);
    this.increaseAvailable(balance, sourceType, amount);
  }

  private async lockWalletBalance(
    manager: EntityManager,
    walletId: string,
  ): Promise<WalletBalance> {
    const balance = await manager
      .getRepository(WalletBalance)
      .createQueryBuilder('balance')
      .setLock('pessimistic_write')
      .where('balance.wallet_id = :walletId', { walletId })
      .getOne();

    if (!balance) {
      throw new WalletBalanceNotFoundError(walletId);
    }

    return balance;
  }

  private async lockWalletHold(
    manager: EntityManager,
    holdId: string,
  ): Promise<WalletHold> {
    const hold = await manager
      .getRepository(WalletHold)
      .createQueryBuilder('hold')
      .setLock('pessimistic_write')
      .where('hold.id = :holdId', { holdId })
      .getOne();

    if (!hold) {
      throw new WalletHoldNotFoundError(holdId);
    }

    return hold;
  }

  private async lockHoldAllocations(
    manager: EntityManager,
    holdId: string,
  ): Promise<WalletHoldAllocation[]> {
    return manager
      .getRepository(WalletHoldAllocation)
      .createQueryBuilder('allocation')
      .setLock('pessimistic_write')
      .where('allocation.hold_id = :holdId', { holdId })
      .orderBy('allocation.id', 'ASC')
      .getMany();
  }

  private async lockAvailablePointLots(
    manager: EntityManager,
    walletId: string,
  ): Promise<WalletPointLot[]> {
    const now = new Date();

    const lots = await manager
      .getRepository(WalletPointLot)
      .createQueryBuilder('lot')
      .setLock('pessimistic_write')
      .where('lot.wallet_id = :walletId', { walletId })
      .andWhere('lot.available_amount > 0')
      .andWhere('(lot.expires_at IS NULL OR lot.expires_at > :now)', { now })
      .orderBy('lot.id', 'ASC')
      .getMany();

    return lots.sort((a, b) => {
      const sourceDiff =
        SOURCE_PRIORITY[a.sourceType] - SOURCE_PRIORITY[b.sourceType];
      if (sourceDiff !== 0) {
        return sourceDiff;
      }
      const createdDiff = a.createdAt.getTime() - b.createdAt.getTime();
      if (createdDiff !== 0) {
        return createdDiff;
      }
      return a.id.localeCompare(b.id);
    });
  }

  private async lockPointLotsByIds(
    manager: EntityManager,
    pointLotIds: string[],
  ): Promise<WalletPointLot[]> {
    if (pointLotIds.length === 0) {
      return [];
    }

    const uniqueIds = [...new Set(pointLotIds)].sort();

    return manager
      .getRepository(WalletPointLot)
      .createQueryBuilder('lot')
      .setLock('pessimistic_write')
      .where('lot.id IN (:...ids)', { ids: uniqueIds })
      .orderBy('lot.id', 'ASC')
      .getMany();
  }

  private planLotConsumption(
    lots: WalletPointLot[],
    amount: bigint,
  ): LotAllocationPlan[] {
    let remaining = amount;
    const plans: LotAllocationPlan[] = [];

    for (const sourceType of CONSUMPTION_SOURCE_ORDER) {
      const sourceLots = lots.filter((lot) => lot.sourceType === sourceType);
      for (const lot of sourceLots) {
        if (remaining <= 0n) {
          break;
        }

        const lotAvailable = BigInt(lot.availableAmount);
        if (lotAvailable <= 0n) {
          continue;
        }

        const take = lotAvailable < remaining ? lotAvailable : remaining;
        plans.push({ lot, amount: take });
        remaining -= take;
      }
    }

    if (remaining > 0n) {
      throw new InsufficientWalletBalanceError();
    }

    return plans;
  }

  private assertHoldActive(hold: WalletHold): void {
    if (hold.status === WalletHoldStatus.ACTIVE) {
      return;
    }

    if (hold.status === WalletHoldStatus.RELEASED) {
      throw new WalletHoldAlreadyReleasedError(hold.id);
    }

    if (hold.status === WalletHoldStatus.CONSUMED) {
      throw new WalletHoldAlreadyConsumedError(hold.id);
    }

    throw new WalletHoldNotActiveError(hold.id);
  }

  private async findTransactionByIdempotencyKey(
    manager: EntityManager,
    idempotencyKey: string,
  ): Promise<WalletTransaction | null> {
    return manager.findOne(WalletTransaction, {
      where: { idempotencyKey },
    });
  }

  private async findHoldParentTransaction(
    manager: EntityManager,
    hold: WalletHold,
  ): Promise<WalletTransaction | null> {
    return manager.findOne(WalletTransaction, {
      where: {
        walletId: hold.walletId,
        transactionType: WalletTransactionType.ASSURED_DEPOSIT_HOLD,
        referenceType: hold.referenceType,
        referenceId: hold.referenceId,
      },
      order: { createdAt: 'ASC' },
    });
  }

  private static readonly IDEMPOTENCY_CONSTRAINT =
    'UQ_wallet_transactions_idempotency_key';

  private static readonly ACTIVE_HOLD_REFERENCE_CONSTRAINT =
    'UQ_wallet_holds_active_reference';

  private isActiveHoldReferenceUniqueViolation(error: unknown): boolean {
    let current: unknown = error;
    while (current) {
      if (typeof current === 'object' && current !== null) {
        const record = current as {
          code?: string;
          constraint?: string;
          driverError?: { code?: string; constraint?: string };
          cause?: unknown;
        };
        const code = record.code ?? record.driverError?.code;
        const constraint =
          record.constraint ?? record.driverError?.constraint;
        if (
          code === '23505' &&
          (constraint === WalletService.ACTIVE_HOLD_REFERENCE_CONSTRAINT ||
            Boolean(constraint?.includes('active_reference')))
        ) {
          return true;
        }
        current = record.cause;
        continue;
      }
      break;
    }
    return false;
  }

  private isIdempotencyUniqueViolation(error: unknown): boolean {
    let current: unknown = error;

    while (current) {
      if (typeof current === 'object' && current !== null) {
        const record = current as {
          code?: string;
          constraint?: string;
          driverError?: { code?: string; constraint?: string };
          cause?: unknown;
        };

        const code = record.code ?? record.driverError?.code;
        const constraint =
          record.constraint ?? record.driverError?.constraint;

        if (
          code === '23505' &&
          constraint === WalletService.IDEMPOTENCY_CONSTRAINT
        ) {
          return true;
        }

        if (current instanceof QueryFailedError) {
          const driverError = current.driverError as
            | { code?: string; constraint?: string }
            | undefined;
          if (
            driverError?.code === '23505' &&
            driverError.constraint === WalletService.IDEMPOTENCY_CONSTRAINT
          ) {
            return true;
          }
        }

        current = record.cause;
        continue;
      }

      break;
    }

    return false;
  }

  private async buildResultFromExistingTransaction(
    manager: EntityManager,
    transaction: WalletTransaction,
  ): Promise<WalletOperationResult> {
    const balance = await manager.findOne(WalletBalance, {
      where: { walletId: transaction.walletId },
    });
    if (!balance) {
      throw new WalletBalanceNotFoundError(transaction.walletId);
    }

    const hold = await this.findHoldForTransaction(transaction, manager);

    return {
      transaction,
      balance,
      hold,
    };
  }

  private async buildResultFromExistingHoldRelease(
    manager: EntityManager,
    hold: WalletHold,
  ): Promise<WalletOperationResult> {
    const transaction = await manager.findOne(WalletTransaction, {
      where: {
        transactionType: WalletTransactionType.HOLD_RELEASE,
        referenceType: 'wallet_hold',
        referenceId: hold.id,
      },
      order: { createdAt: 'DESC' },
    });
    if (!transaction) {
      throw new WalletOperationConflictError(
        `Hold ${hold.id} is RELEASED but HOLD_RELEASE ledger entry was not found`,
      );
    }
    return this.buildResultFromExistingTransaction(manager, transaction);
  }

  private async buildResultFromExistingHoldConsume(
    manager: EntityManager,
    hold: WalletHold,
  ): Promise<WalletOperationResult> {
    const transaction = await manager.findOne(WalletTransaction, {
      where: {
        transactionType: WalletTransactionType.HOLD_CONSUMED,
        referenceType: 'wallet_hold',
        referenceId: hold.id,
      },
      order: { createdAt: 'DESC' },
    });
    if (!transaction) {
      throw new WalletOperationConflictError(
        `Hold ${hold.id} is CONSUMED but HOLD_CONSUMED ledger entry was not found`,
      );
    }
    return this.buildResultFromExistingTransaction(manager, transaction);
  }
}
