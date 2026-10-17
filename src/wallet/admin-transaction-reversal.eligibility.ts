import {
  WalletTransaction,
  WalletTransactionDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';
import { ADMIN_TX_REVERSAL_REFERENCE_TYPE } from './wallet.constants';

/**
 * Ledger types whose balances move only via available lots (credit/debit).
 * Hold lifecycle and withdrawal consume/release must use those dedicated flows.
 */
const INELIGIBLE_TYPES: ReadonlySet<WalletTransactionType> = new Set([
  WalletTransactionType.ASSURED_DEPOSIT_HOLD,
  WalletTransactionType.HOLD_RELEASE,
  WalletTransactionType.HOLD_CONSUMED,
  WalletTransactionType.WITHDRAWAL,
  WalletTransactionType.WITHDRAWAL_REVERSAL,
  WalletTransactionType.PLATFORM_SEED,
]);

export type AdminReversalIneligibilityReason =
  | 'NOT_POSTED'
  | 'HOLD_OR_WITHDRAWAL_LIFECYCLE'
  | 'PLATFORM_SEED'
  | 'ALREADY_ADMIN_REVERSAL_ROW'
  | 'ALREADY_REVERSED';

export function evaluateAdminReversalEligibility(
  original: WalletTransaction,
  existingAdminReversal: WalletTransaction | null,
):
  | { eligible: true }
  | {
      eligible: false;
      reason: AdminReversalIneligibilityReason;
      message: string;
    } {
  if (existingAdminReversal) {
    return {
      eligible: false,
      reason: 'ALREADY_REVERSED',
      message: 'This transaction already has an admin compensating reversal.',
    };
  }

  if (original.status !== WalletTransactionStatus.POSTED) {
    return {
      eligible: false,
      reason: 'NOT_POSTED',
      message: 'Only POSTED ledger rows can be reversed.',
    };
  }

  if (original.referenceType === ADMIN_TX_REVERSAL_REFERENCE_TYPE) {
    return {
      eligible: false,
      reason: 'ALREADY_ADMIN_REVERSAL_ROW',
      message:
        'Admin reversal rows cannot themselves be reversed via this API.',
    };
  }

  if (original.transactionType === WalletTransactionType.PLATFORM_SEED) {
    return {
      eligible: false,
      reason: 'PLATFORM_SEED',
      message: 'Platform seed credits cannot be reversed via this API.',
    };
  }

  if (INELIGIBLE_TYPES.has(original.transactionType)) {
    return {
      eligible: false,
      reason: 'HOLD_OR_WITHDRAWAL_LIFECYCLE',
      message:
        'Hold/withdrawal ledger rows must be corrected via hold release/consume or withdrawal status flows, not admin reverse.',
    };
  }

  if (
    original.direction !== WalletTransactionDirection.CREDIT &&
    original.direction !== WalletTransactionDirection.DEBIT
  ) {
    return {
      eligible: false,
      reason: 'HOLD_OR_WITHDRAWAL_LIFECYCLE',
      message: 'Unsupported ledger direction for admin reverse.',
    };
  }

  return { eligible: true };
}

export function isAdminReversalEligibleType(
  type: WalletTransactionType,
): boolean {
  return !INELIGIBLE_TYPES.has(type);
}
