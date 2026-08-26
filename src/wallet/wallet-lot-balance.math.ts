import { WalletBalance } from './entities/wallet-balance.entity';
import {
  WalletPointLot,
  WalletPointSource,
} from './entities/wallet-point-lot.entity';

export type WalletBalanceBucket =
  | 'PURCHASED_AVAILABLE'
  | 'PURCHASED_HELD'
  | 'PROMOTIONAL_AVAILABLE'
  | 'PROMOTIONAL_HELD'
  | 'DRIVER_EARNED_AVAILABLE'
  | 'DRIVER_EARNED_HELD';

export interface WalletBalanceDriftItem {
  bucket: WalletBalanceBucket;
  expected: string;
  actual: string;
}

export interface WalletReconciliationResult {
  ok: boolean;
  drift: WalletBalanceDriftItem[];
}

/** Matches WalletService spending: expired lots are not spendable. */
export function isLotAvailableForSpending(
  lot: Pick<WalletPointLot, 'expiresAt'>,
  now: Date,
): boolean {
  if (lot.expiresAt === null) {
    return true;
  }
  return lot.expiresAt.getTime() > now.getTime();
}

export function sumLotFieldAmounts(
  lots: WalletPointLot[],
  sourceType: WalletPointSource,
  field: 'availableAmount' | 'heldAmount',
): bigint {
  return lots
    .filter((lot) => lot.sourceType === sourceType)
    .reduce((total, lot) => total + BigInt(lot[field]), 0n);
}

/** Spendable available: excludes expired lot available amounts. */
export function sumSpendableLotAvailable(
  lots: WalletPointLot[],
  sourceType: WalletPointSource,
  now: Date,
): bigint {
  return lots
    .filter((lot) => lot.sourceType === sourceType)
    .filter((lot) => isLotAvailableForSpending(lot, now))
    .reduce((total, lot) => total + BigInt(lot.availableAmount), 0n);
}

export function getExpectedBalanceBucketsFromLots(
  lots: WalletPointLot[],
  now: Date,
): Record<WalletBalanceBucket, bigint> {
  return {
    PURCHASED_AVAILABLE: sumSpendableLotAvailable(
      lots,
      WalletPointSource.PURCHASED,
      now,
    ),
    PURCHASED_HELD: sumLotFieldAmounts(
      lots,
      WalletPointSource.PURCHASED,
      'heldAmount',
    ),
    PROMOTIONAL_AVAILABLE: sumSpendableLotAvailable(
      lots,
      WalletPointSource.PROMOTIONAL,
      now,
    ),
    PROMOTIONAL_HELD: sumLotFieldAmounts(
      lots,
      WalletPointSource.PROMOTIONAL,
      'heldAmount',
    ),
    DRIVER_EARNED_AVAILABLE: sumSpendableLotAvailable(
      lots,
      WalletPointSource.DRIVER_EARNED,
      now,
    ),
    DRIVER_EARNED_HELD: sumLotFieldAmounts(
      lots,
      WalletPointSource.DRIVER_EARNED,
      'heldAmount',
    ),
  };
}

export function getActualBalanceBuckets(
  balance: WalletBalance,
): Record<WalletBalanceBucket, bigint> {
  return {
    PURCHASED_AVAILABLE: BigInt(balance.purchasedAvailable),
    PURCHASED_HELD: BigInt(balance.purchasedHeld),
    PROMOTIONAL_AVAILABLE: BigInt(balance.promotionalAvailable),
    PROMOTIONAL_HELD: BigInt(balance.promotionalHeld),
    DRIVER_EARNED_AVAILABLE: BigInt(balance.driverEarnedAvailable),
    DRIVER_EARNED_HELD: BigInt(balance.driverEarnedHeld),
  };
}

export function reconcileBalanceWithLots(
  balance: WalletBalance,
  lots: WalletPointLot[],
  now: Date = new Date(),
): WalletReconciliationResult {
  const expected = getExpectedBalanceBucketsFromLots(lots, now);
  const actual = getActualBalanceBuckets(balance);
  const drift: WalletBalanceDriftItem[] = [];

  for (const bucket of Object.keys(expected) as WalletBalanceBucket[]) {
    if (expected[bucket] !== actual[bucket]) {
      drift.push({
        bucket,
        expected: expected[bucket].toString(),
        actual: actual[bucket].toString(),
      });
    }
  }

  return {
    ok: drift.length === 0,
    drift,
  };
}

export function decreaseAvailableBalance(
  balance: WalletBalance,
  sourceType: WalletPointSource,
  amount: bigint,
): void {
  switch (sourceType) {
    case WalletPointSource.PURCHASED:
      balance.purchasedAvailable = (
        BigInt(balance.purchasedAvailable) - amount
      ).toString();
      return;
    case WalletPointSource.PROMOTIONAL:
      balance.promotionalAvailable = (
        BigInt(balance.promotionalAvailable) - amount
      ).toString();
      return;
    case WalletPointSource.DRIVER_EARNED:
      balance.driverEarnedAvailable = (
        BigInt(balance.driverEarnedAvailable) - amount
      ).toString();
      return;
    default: {
      const exhaustive: never = sourceType;
      throw new Error(`Unsupported point source: ${exhaustive}`);
    }
  }
}

export function getTotalWalletBalance(balance: WalletBalance): bigint {
  return (
    BigInt(balance.purchasedAvailable) +
    BigInt(balance.promotionalAvailable) +
    BigInt(balance.driverEarnedAvailable) +
    BigInt(balance.purchasedHeld) +
    BigInt(balance.promotionalHeld) +
    BigInt(balance.driverEarnedHeld)
  );
}
