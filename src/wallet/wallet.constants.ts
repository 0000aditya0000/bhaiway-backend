/**
 * Maximum coins (₹) allowed per top-up order.
 * 1 Coin = ₹1; values are integer strings at API boundaries.
 */
export const MAX_TOP_UP_AMOUNT_COINS = '100000';

export const TOP_UP_CREDIT_IDEMPOTENCY_PREFIX = 'top-up-credit:';

export const PAYMENT_ORDER_REFERENCE_TYPE = 'PAYMENT_ORDER';

export const LOT_EXPIRY_IDEMPOTENCY_PREFIX = 'lot-expiry:';

export const LOT_EXPIRY_REFERENCE_TYPE = 'LOT_EXPIRY';

/** Compensating admin reversal of a prior ledger row (immutable original). */
export const ADMIN_TX_REVERSAL_REFERENCE_TYPE = 'ADMIN_TX_REVERSAL';

export const ADMIN_TX_REVERSAL_IDEMPOTENCY_PREFIX = 'admin-tx-reverse:';
