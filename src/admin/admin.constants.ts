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

/** Reserved backing user for the bootstrap dashboard admin (not the platform wallet user). */
export const ADMIN_BOOTSTRAP_USER_ID =
  '00000000-0000-4000-8000-000000000099';
export const ADMIN_BOOTSTRAP_PHONE = '+10000000099';
export const ADMIN_BOOTSTRAP_USERNAME_DEFAULT = 'lucifer';
