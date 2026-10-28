/** No-Show reporting is eligible this long after scheduled Kolkata departure. */
export const NO_SHOW_ELIGIBLE_AFTER_MS = 5 * 60 * 1000;

/** Counterparty must approve or reject within this window. */
export const NO_SHOW_RESPONSE_WINDOW_MS = 15 * 60 * 1000;

export const NO_SHOW_WORKER_POLL_MS = 15_000;

export const NO_SHOW_WORKER_BATCH_SIZE = 25;

/** Matches notification-email retry: 5 attempts, 5s exponential backoff. */
export const NO_SHOW_EFFECT_MAX_ATTEMPTS = 5;

export const NO_SHOW_EFFECT_RETRY_BASE_MS = 5_000;
