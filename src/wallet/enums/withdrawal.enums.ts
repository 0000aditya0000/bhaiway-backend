export enum PaymentMethodType {
  UPI = 'UPI',
  BANK_ACCOUNT = 'BANK_ACCOUNT',
}

export enum WithdrawalStatus {
  INITIATED = 'INITIATED',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export enum WithdrawalProvider {
  MANUAL = 'MANUAL',
}

/** Admin-managed manual payouts only (no payout gateway). */
export const WITHDRAWAL_REFERENCE_TYPE = 'withdrawal';

export const WITHDRAWAL_HOLD_IDEMPOTENCY_PREFIX = 'withdrawal-hold:';
export const WITHDRAWAL_RELEASE_IDEMPOTENCY_PREFIX = 'withdrawal-release:';
export const WITHDRAWAL_CONSUME_IDEMPOTENCY_PREFIX = 'withdrawal-consume:';

export const WITHDRAWAL_ALLOWED_TRANSITIONS: Readonly<
  Record<WithdrawalStatus, readonly WithdrawalStatus[]>
> = {
  [WithdrawalStatus.INITIATED]: [
    WithdrawalStatus.PROCESSING,
    WithdrawalStatus.FAILED,
    WithdrawalStatus.CANCELLED,
  ],
  [WithdrawalStatus.PROCESSING]: [
    WithdrawalStatus.COMPLETED,
    WithdrawalStatus.FAILED,
    WithdrawalStatus.CANCELLED,
  ],
  [WithdrawalStatus.COMPLETED]: [],
  [WithdrawalStatus.FAILED]: [],
  [WithdrawalStatus.CANCELLED]: [],
};
