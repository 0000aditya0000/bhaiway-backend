/**
 * Currency conversion utility for BhaiWay Coin (₹1) <-> Razorpay paise.
 * Integer arithmetic only. No floating point operations.
 */

const PAISE_PER_RUPEE = 100n;

/**
 * Converts BhaiWay integer coins (1 Coin = ₹1) to Razorpay paise (1 Rupee = 100 paise).
 * @param coins Positive integer string or bigint representing coins.
 * @returns Integer number of paise safe for Razorpay order creation.
 */
export function coinsToPaise(coins: string | bigint): number {
  const coinsBigInt = typeof coins === 'bigint' ? coins : BigInt(coins.trim());
  if (coinsBigInt <= 0n) {
    throw new Error('Coin amount must be greater than zero');
  }

  const paiseBigInt = coinsBigInt * PAISE_PER_RUPEE;
  if (paiseBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Amount exceeds maximum safe integer range');
  }

  return Number(paiseBigInt);
}

/**
 * Converts Razorpay paise to BhaiWay integer coins (1 Coin = ₹1).
 * Validates that paise is an exact multiple of 100 (integer rupees).
 * @param paise Integer paise from Razorpay.
 * @returns Integer string of BhaiWay coins.
 */
export function paiseToCoins(paise: number | string | bigint): string {
  const paiseBigInt =
    typeof paise === 'bigint'
      ? paise
      : BigInt(Math.floor(Number(paise)));

  if (paiseBigInt <= 0n) {
    throw new Error('Paise amount must be greater than zero');
  }

  if (paiseBigInt % PAISE_PER_RUPEE !== 0n) {
    throw new Error(`Paise amount ${paiseBigInt} is not an exact rupee multiple`);
  }

  return (paiseBigInt / PAISE_PER_RUPEE).toString();
}
