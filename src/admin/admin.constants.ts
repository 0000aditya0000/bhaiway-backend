import { WalletTransactionType } from '../wallet/entities/wallet-transaction.entity';

/**
 * Ledger types credited to the platform wallet that represent BhaiWay
 * platform revenue (not rider fare gross, driver earnings, top-ups, or seed).
 *
 * Source of truth: wallet_transactions on PLATFORM_WALLET_ID.
 */
export const PLATFORM_REVENUE_TRANSACTION_TYPES: readonly WalletTransactionType[] =
  [
    WalletTransactionType.COMMUTE_PLATFORM_MARGIN,
    WalletTransactionType.ASSURED_PLATFORM_FORFEITURE,
    WalletTransactionType.ASSURED_PASSENGER_CANCEL_FARE_PLATFORM,
  ] as const;

export const ADMIN_PERMISSION_DASHBOARD_VIEW = 'ADMIN_DASHBOARD_VIEW';
export const ADMIN_PERMISSION_WITHDRAWALS_MANAGE = 'ADMIN_WITHDRAWALS_MANAGE';
export const ADMIN_PERMISSION_COUPONS_MANAGE = 'ADMIN_COUPONS_MANAGE';
export const ADMIN_PERMISSION_COMMUTE_REWARDS_MANAGE =
  'ADMIN_COMMUTE_REWARDS_MANAGE';
/** List/inspect wallet ledger transactions across users. */
export const ADMIN_PERMISSION_TRANSACTIONS_VIEW = 'ADMIN_TRANSACTIONS_VIEW';
/** Post compensating ledger reversals for eligible transactions. */
export const ADMIN_PERMISSION_TRANSACTIONS_REVERSE =
  'ADMIN_TRANSACTIONS_REVERSE';
/** List/manage help & support tickets, status, and admin comments. */
export const ADMIN_PERMISSION_SUPPORT_MANAGE = 'ADMIN_SUPPORT_MANAGE';
/** View users directory and user detail. */
export const ADMIN_PERMISSION_USERS_VIEW = 'ADMIN_USERS_VIEW';
/** Suspend/unsuspend users and manage booking/publish restrictions. */
export const ADMIN_PERMISSION_USERS_MANAGE = 'ADMIN_USERS_MANAGE';
/** View drivers directory and driver detail. */
export const ADMIN_PERMISSION_DRIVERS_VIEW = 'ADMIN_DRIVERS_VIEW';

/** Reserved backing user for the bootstrap dashboard admin (not the platform wallet user). */
export const ADMIN_BOOTSTRAP_USER_ID = '00000000-0000-4000-8000-000000000099';
export const ADMIN_BOOTSTRAP_PHONE = '+10000000099';
export const ADMIN_BOOTSTRAP_USERNAME_DEFAULT = 'lucifer';
