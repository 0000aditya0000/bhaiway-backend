import { WalletHoldType } from '../entities/wallet-hold.entity';
import { WalletPointSource } from '../entities/wallet-point-lot.entity';
import { WalletBalance } from '../entities/wallet-balance.entity';
import { WalletHold } from '../entities/wallet-hold.entity';
import {
  WalletTransaction,
  WalletTransactionType,
} from '../entities/wallet-transaction.entity';

export interface CreditPointsInput {
  walletId: string;
  userId: string;
  amount: bigint;
  sourceType: WalletPointSource;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey: string;
  /** Override default credit ledger type (e.g. compensation). */
  transactionType?: WalletTransactionType;
  /**
   * Required to credit the platform wallet.
   * Normal user-facing flows must leave this false/undefined.
   */
  allowPlatformOperations?: boolean;
}

export interface DebitPointsInput {
  walletId: string;
  userId: string;
  amount: bigint;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey: string;
  /** Override default debit ledger type (default BOOKING_PAYMENT). */
  transactionType?: WalletTransactionType;
  /**
   * Required to debit the platform wallet.
   * Normal user-facing flows must leave this false/undefined.
   */
  allowPlatformOperations?: boolean;
}

export interface CreateHoldInput {
  walletId: string;
  amount: bigint;
  /**
   * Assured-deposit holds only. Other hold types are not supported by this API.
   */
  holdType: WalletHoldType;
  referenceType: string;
  referenceId: string;
  expiresAt?: Date | null;
  idempotencyKey: string;
}

export interface ReleaseHoldInput {
  holdId: string;
  idempotencyKey: string;
}

export interface ConsumeHoldInput {
  holdId: string;
  idempotencyKey: string;
}

export interface WalletOperationResult {
  transaction: WalletTransaction;
  balance: WalletBalance;
  hold?: WalletHold;
}
