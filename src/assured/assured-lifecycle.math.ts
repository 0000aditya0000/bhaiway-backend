/**
 * Assured Phase 4 money helpers — integer Points only, ROUND HALF UP.
 */

/** (amount × percentage) / 100 with HALF UP. */
export function percentOfAmountHalfUp(
  amount: bigint,
  percentage: number,
): bigint {
  if (amount < 0n) {
    throw new Error('Amount cannot be negative');
  }
  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
    throw new Error('Percentage must be an integer from 0 to 100');
  }
  return (amount * BigInt(percentage) + 50n) / 100n;
}

/**
 * Distribute `total` across `count` recipients.
 * Remainder (+1) goes to the first `remainder` recipients (already sorted).
 */
export function distributeEvenlyWithRemainder(
  total: bigint,
  count: number,
): bigint[] {
  if (count <= 0) {
    return [];
  }
  if (total < 0n) {
    throw new Error('Total cannot be negative');
  }
  const n = BigInt(count);
  const base = total / n;
  const rem = Number(total % n);
  const shares: bigint[] = [];
  for (let i = 0; i < count; i += 1) {
    shares.push(base + (i < rem ? 1n : 0n));
  }
  return shares;
}

/** Partial-fill: min(emptySeats, 2) × price × 50%, capped at 700. */
export function calculatePartialFillCompensation(
  emptySeats: number,
  pricePerSeat: bigint,
): bigint {
  if (!Number.isInteger(emptySeats) || emptySeats < 0) {
    throw new Error('emptySeats must be a non-negative integer');
  }
  if (pricePerSeat < 0n) {
    throw new Error('pricePerSeat cannot be negative');
  }
  const covered = Math.min(emptySeats, 2);
  if (covered === 0) {
    return 0n;
  }
  const raw = percentOfAmountHalfUp(BigInt(covered) * pricePerSeat, 50);
  const cap = 700n;
  return raw < cap ? raw : cap;
}

export const PARTIAL_FILL_MAX_SEATS = 2;
export const PARTIAL_FILL_MAX_POINTS = 700n;
export const DRIVER_FORFEIT_RIDER_SHARE_PERCENT = 60;
export const DRIVER_FORFEIT_PLATFORM_SHARE_PERCENT = 40;
