import { RideType } from '../rides/enums/ride.enums';
import {
  WalletTransactionDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';
import { PAYMENT_ORDER_REFERENCE_TYPE } from './wallet.constants';
import {
  getWalletTransactionDisplay,
  WalletTransactionDisplayCategory,
} from './wallet-transaction-display.mapper';

describe('wallet-transaction-display.mapper', () => {
  const base = {
    direction: WalletTransactionDirection.CREDIT,
    status: WalletTransactionStatus.POSTED,
    referenceType: null as string | null,
    idempotencyKey: 'test-key',
  };

  it('labels coins purchased from payment order', () => {
    expect(
      getWalletTransactionDisplay({
        ...base,
        transactionType: WalletTransactionType.POINT_PURCHASE,
        referenceType: PAYMENT_ORDER_REFERENCE_TYPE,
        idempotencyKey: 'top-up-credit:order-1',
      }),
    ).toEqual({
      displayTitle: 'Coins purchased',
      displayCategory: WalletTransactionDisplayCategory.TOP_UP,
    });
  });

  it('labels commute booking payment', () => {
    expect(
      getWalletTransactionDisplay(
        {
          ...base,
          direction: WalletTransactionDirection.DEBIT,
          transactionType: WalletTransactionType.BOOKING_PAYMENT,
          referenceType: 'BOOKING',
        },
        RideType.COMMUTE,
      ),
    ).toEqual({
      displayTitle: 'Office commute booked',
      displayCategory: WalletTransactionDisplayCategory.BOOKING,
    });
  });

  it('labels driver earnings by ride type', () => {
    expect(
      getWalletTransactionDisplay(
        {
          ...base,
          transactionType: WalletTransactionType.DRIVER_EARNING,
        },
        RideType.ASSURED,
      ),
    ).toEqual({
      displayTitle: 'Assured ride earnings',
      displayCategory: WalletTransactionDisplayCategory.EARNING,
    });
  });

  it('labels assured deposit hold and release', () => {
    expect(
      getWalletTransactionDisplay({
        ...base,
        direction: WalletTransactionDirection.DEBIT,
        transactionType: WalletTransactionType.ASSURED_DEPOSIT_HOLD,
      }),
    ).toEqual({
      displayTitle: 'Assured security deposit held',
      displayCategory: WalletTransactionDisplayCategory.DEPOSIT,
    });

    expect(
      getWalletTransactionDisplay({
        ...base,
        transactionType: WalletTransactionType.HOLD_RELEASE,
        idempotencyKey: 'assured-deposit-release:hold-1',
      }),
    ).toEqual({
      displayTitle: 'Assured security deposit released',
      displayCategory: WalletTransactionDisplayCategory.DEPOSIT,
    });
  });

  it('labels commute cancellation refunds from idempotency key', () => {
    expect(
      getWalletTransactionDisplay({
        ...base,
        transactionType: WalletTransactionType.REFUND,
        idempotencyKey: 'commute:rider-cancel:booking-1',
      }),
    ).toEqual({
      displayTitle: 'Ride cancellation refund',
      displayCategory: WalletTransactionDisplayCategory.CANCELLATION,
    });
  });

  it('labels bonus and compensation entries', () => {
    expect(
      getWalletTransactionDisplay({
        ...base,
        transactionType: WalletTransactionType.PROMOTIONAL_CREDIT,
      }),
    ).toEqual({
      displayTitle: 'Bonus coins added',
      displayCategory: WalletTransactionDisplayCategory.BONUS,
    });

    expect(
      getWalletTransactionDisplay({
        ...base,
        transactionType: WalletTransactionType.ASSURED_RIDER_COMPENSATION,
      }),
    ).toEqual({
      displayTitle: 'Ride cancellation compensation',
      displayCategory: WalletTransactionDisplayCategory.COMPENSATION,
    });
  });

  it('appends reversed suffix', () => {
    expect(
      getWalletTransactionDisplay({
        ...base,
        transactionType: WalletTransactionType.REFUND,
        status: WalletTransactionStatus.REVERSED,
        idempotencyKey: 'commute:ride-cancel:booking-1',
      }),
    ).toEqual({
      displayTitle: 'Ride cancelled — refund (reversed)',
      displayCategory: WalletTransactionDisplayCategory.CANCELLATION,
    });
  });
});
