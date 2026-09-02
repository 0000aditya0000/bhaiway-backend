import { RideType } from '../rides/enums/ride.enums';
import {
  WalletTransaction,
  WalletTransactionStatus,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';
import { PAYMENT_ORDER_REFERENCE_TYPE } from './wallet.constants';

export enum WalletTransactionDisplayCategory {
  TOP_UP = 'TOP_UP',
  BOOKING = 'BOOKING',
  EARNING = 'EARNING',
  REFUND = 'REFUND',
  DEPOSIT = 'DEPOSIT',
  BONUS = 'BONUS',
  CANCELLATION = 'CANCELLATION',
  COMPENSATION = 'COMPENSATION',
  WITHDRAWAL = 'WITHDRAWAL',
  PENALTY = 'PENALTY',
  ADJUSTMENT = 'ADJUSTMENT',
  OTHER = 'OTHER',
}

export interface WalletTransactionDisplay {
  displayTitle: string;
  displayCategory: WalletTransactionDisplayCategory;
}

const RIDE_TYPE_LABEL: Record<RideType, string> = {
  [RideType.REGULAR]: 'Regular ride',
  [RideType.ASSURED]: 'Assured ride',
  [RideType.COMMUTE]: 'Office commute',
};

function ridePrefix(rideType?: RideType): string {
  if (!rideType) {
    return 'Ride';
  }
  return RIDE_TYPE_LABEL[rideType];
}

function refundTitleFromIdempotencyKey(idempotencyKey: string): string | null {
  if (idempotencyKey.startsWith('commute:reject:')) {
    return 'Booking request rejected — refund';
  }
  if (idempotencyKey.startsWith('commute:rider-cancel:')) {
    return 'Ride cancellation refund';
  }
  if (idempotencyKey.startsWith('commute:ride-full:')) {
    return 'Ride full — booking refund';
  }
  if (idempotencyKey.startsWith('commute:ride-cancel:')) {
    return 'Ride cancelled — refund';
  }
  if (idempotencyKey.startsWith('assured:fare-refund:')) {
    return 'Assured ride fare refund';
  }
  if (idempotencyKey.startsWith('assured-deposit-release:')) {
    return 'Assured security deposit released';
  }
  if (idempotencyKey.startsWith('top-up-credit:')) {
    return 'Coins purchased';
  }
  return null;
}

export function getWalletTransactionDisplay(
  tx: Pick<
    WalletTransaction,
    | 'transactionType'
    | 'direction'
    | 'status'
    | 'referenceType'
    | 'idempotencyKey'
  >,
  rideType?: RideType,
): WalletTransactionDisplay {
  const base = resolveWalletTransactionDisplay(tx, rideType);
  if (tx.status === WalletTransactionStatus.REVERSED) {
    return {
      ...base,
      displayTitle: `${base.displayTitle} (reversed)`,
    };
  }
  return base;
}

function resolveWalletTransactionDisplay(
  tx: Pick<
    WalletTransaction,
    'transactionType' | 'direction' | 'referenceType' | 'idempotencyKey'
  >,
  rideType?: RideType,
): WalletTransactionDisplay {
  const idempotencyTitle = refundTitleFromIdempotencyKey(tx.idempotencyKey);
  if (idempotencyTitle) {
    return {
      displayTitle: idempotencyTitle,
      displayCategory: categoryForIdempotency(tx.idempotencyKey),
    };
  }

  switch (tx.transactionType) {
    case WalletTransactionType.POINT_PURCHASE:
      return {
        displayTitle:
          tx.referenceType === PAYMENT_ORDER_REFERENCE_TYPE
            ? 'Coins purchased'
            : 'Wallet top-up',
        displayCategory: WalletTransactionDisplayCategory.TOP_UP,
      };

    case WalletTransactionType.PROMOTIONAL_CREDIT:
      return {
        displayTitle: 'Bonus coins added',
        displayCategory: WalletTransactionDisplayCategory.BONUS,
      };

    case WalletTransactionType.DRIVER_EARNING:
      return {
        displayTitle: `${ridePrefix(rideType)} earnings`,
        displayCategory: WalletTransactionDisplayCategory.EARNING,
      };

    case WalletTransactionType.BOOKING_PAYMENT:
      return {
        displayTitle: bookingPaymentTitle(rideType),
        displayCategory: WalletTransactionDisplayCategory.BOOKING,
      };

    case WalletTransactionType.ASSURED_DEPOSIT_HOLD:
      return {
        displayTitle: 'Assured security deposit held',
        displayCategory: WalletTransactionDisplayCategory.DEPOSIT,
      };

    case WalletTransactionType.HOLD_RELEASE:
      return {
        displayTitle: 'Assured security deposit released',
        displayCategory: WalletTransactionDisplayCategory.DEPOSIT,
      };

    case WalletTransactionType.HOLD_CONSUMED:
      return {
        displayTitle: 'Assured security deposit used',
        displayCategory: WalletTransactionDisplayCategory.DEPOSIT,
      };

    case WalletTransactionType.REFUND:
      return {
        displayTitle: refundTitle(rideType),
        displayCategory: WalletTransactionDisplayCategory.REFUND,
      };

    case WalletTransactionType.NO_SHOW_FORFEITURE:
      return {
        displayTitle: 'No-show penalty',
        displayCategory: WalletTransactionDisplayCategory.PENALTY,
      };

    case WalletTransactionType.ASSURED_RIDER_COMPENSATION:
      return {
        displayTitle: 'Ride cancellation compensation',
        displayCategory: WalletTransactionDisplayCategory.COMPENSATION,
      };

    case WalletTransactionType.ASSURED_PARTIAL_FILL_COMPENSATION:
      return {
        displayTitle: 'Partial seat compensation',
        displayCategory: WalletTransactionDisplayCategory.COMPENSATION,
      };

    case WalletTransactionType.ASSURED_PASSENGER_CANCEL_DEPOSIT_DRIVER:
      return {
        displayTitle: 'Passenger cancellation — deposit share',
        displayCategory: WalletTransactionDisplayCategory.COMPENSATION,
      };

    case WalletTransactionType.ASSURED_PASSENGER_CANCEL_FARE_DRIVER:
      return {
        displayTitle: 'Passenger cancellation — fare share',
        displayCategory: WalletTransactionDisplayCategory.COMPENSATION,
      };

    case WalletTransactionType.ASSURED_PASSENGER_CANCEL_FARE_PLATFORM:
      return {
        displayTitle: 'Passenger cancellation — platform share',
        displayCategory: WalletTransactionDisplayCategory.OTHER,
      };

    case WalletTransactionType.ASSURED_PLATFORM_FORFEITURE:
      return {
        displayTitle: 'Assured deposit forfeiture',
        displayCategory: WalletTransactionDisplayCategory.OTHER,
      };

    case WalletTransactionType.COMMUTE_PLATFORM_MARGIN:
      return {
        displayTitle: 'Commute platform margin',
        displayCategory: WalletTransactionDisplayCategory.OTHER,
      };

    case WalletTransactionType.WITHDRAWAL:
      return {
        displayTitle: 'Withdrawal',
        displayCategory: WalletTransactionDisplayCategory.WITHDRAWAL,
      };

    case WalletTransactionType.WITHDRAWAL_REVERSAL:
      return {
        displayTitle: 'Withdrawal reversed',
        displayCategory: WalletTransactionDisplayCategory.WITHDRAWAL,
      };

    case WalletTransactionType.ADMIN_ADJUSTMENT:
      return {
        displayTitle:
          tx.referenceType === 'LOT_EXPIRY'
            ? 'Promotional coins expired'
            : 'Wallet adjustment',
        displayCategory: WalletTransactionDisplayCategory.ADJUSTMENT,
      };

    case WalletTransactionType.PLATFORM_SEED:
      return {
        displayTitle: 'Platform seed',
        displayCategory: WalletTransactionDisplayCategory.OTHER,
      };

    default: {
      const typeLabel = String(tx.transactionType).replace(/_/g, ' ').toLowerCase();
      return {
        displayTitle: typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1),
        displayCategory: WalletTransactionDisplayCategory.OTHER,
      };
    }
  }
}

function bookingPaymentTitle(rideType?: RideType): string {
  switch (rideType) {
    case RideType.COMMUTE:
      return 'Office commute booked';
    case RideType.ASSURED:
      return 'Assured ride fare paid';
    case RideType.REGULAR:
      return 'Ride fare paid';
    default:
      return 'Ride booked';
  }
}

function refundTitle(rideType?: RideType): string {
  switch (rideType) {
    case RideType.COMMUTE:
      return 'Commute booking refund';
    case RideType.ASSURED:
      return 'Assured ride refund';
    case RideType.REGULAR:
      return 'Ride refund';
    default:
      return 'Refund credited';
  }
}

function categoryForIdempotency(
  idempotencyKey: string,
): WalletTransactionDisplayCategory {
  if (
    idempotencyKey.startsWith('commute:rider-cancel:') ||
    idempotencyKey.startsWith('commute:ride-cancel:') ||
    idempotencyKey.startsWith('commute:ride-full:')
  ) {
    return WalletTransactionDisplayCategory.CANCELLATION;
  }
  if (idempotencyKey.startsWith('commute:reject:')) {
    return WalletTransactionDisplayCategory.CANCELLATION;
  }
  if (idempotencyKey.startsWith('top-up-credit:')) {
    return WalletTransactionDisplayCategory.TOP_UP;
  }
  if (idempotencyKey.startsWith('assured-deposit-release:')) {
    return WalletTransactionDisplayCategory.DEPOSIT;
  }
  return WalletTransactionDisplayCategory.REFUND;
}
