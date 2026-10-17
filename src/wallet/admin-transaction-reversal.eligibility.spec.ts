import { evaluateAdminReversalEligibility } from './admin-transaction-reversal.eligibility';
import {
  WalletTransactionDirection,
  WalletTransactionStatus,
  WalletTransactionType,
} from './entities/wallet-transaction.entity';
import { ADMIN_TX_REVERSAL_REFERENCE_TYPE } from './wallet.constants';

function tx(
  overrides: Partial<{
    status: WalletTransactionStatus;
    transactionType: WalletTransactionType;
    direction: WalletTransactionDirection;
    referenceType: string | null;
  }> = {},
) {
  return {
    id: 'a',
    status: overrides.status ?? WalletTransactionStatus.POSTED,
    transactionType:
      overrides.transactionType ?? WalletTransactionType.POINT_PURCHASE,
    direction: overrides.direction ?? WalletTransactionDirection.CREDIT,
    referenceType: overrides.referenceType ?? null,
  } as any;
}

describe('evaluateAdminReversalEligibility', () => {
  it('allows simple credit/debit types', () => {
    expect(evaluateAdminReversalEligibility(tx(), null).eligible).toBe(true);
    expect(
      evaluateAdminReversalEligibility(
        tx({
          transactionType: WalletTransactionType.BOOKING_PAYMENT,
          direction: WalletTransactionDirection.DEBIT,
        }),
        null,
      ).eligible,
    ).toBe(true);
  });

  it('rejects hold/withdrawal lifecycle types', () => {
    const r = evaluateAdminReversalEligibility(
      tx({ transactionType: WalletTransactionType.ASSURED_DEPOSIT_HOLD }),
      null,
    );
    expect(r.eligible).toBe(false);
  });

  it('rejects already-reversed and admin-reversal rows', () => {
    expect(
      evaluateAdminReversalEligibility(tx(), tx()).eligible,
    ).toBe(false);
    expect(
      evaluateAdminReversalEligibility(
        tx({ referenceType: ADMIN_TX_REVERSAL_REFERENCE_TYPE }),
        null,
      ).eligible,
    ).toBe(false);
  });
});
