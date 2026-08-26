/**
 * Maps internal wallet point amounts to API-facing BhaiWay Coins.
 * 1 Coin = ₹1 — identity mapping only; no float math.
 */
export function pointsToCoins(points: string | bigint): string {
  return typeof points === 'bigint' ? points.toString() : points;
}

export function sumPoints(values: string[]): string {
  return values
    .reduce((total, value) => total + BigInt(value), 0n)
    .toString();
}
