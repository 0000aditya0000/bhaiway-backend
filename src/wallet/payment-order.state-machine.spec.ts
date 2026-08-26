import { PaymentOrderStatus } from './enums/payment-order.enums';
import { PaymentOrderTerminalStateError } from './errors/top-up.errors';
import { assertPaymentOrderTransition } from './payment-order.state-machine';

describe('payment-order.state-machine', () => {
  it('allows PENDING -> SUCCESS | FAILED | CANCELLED', () => {
    expect(() =>
      assertPaymentOrderTransition(
        PaymentOrderStatus.PENDING,
        PaymentOrderStatus.SUCCESS,
      ),
    ).not.toThrow();
    expect(() =>
      assertPaymentOrderTransition(
        PaymentOrderStatus.PENDING,
        PaymentOrderStatus.FAILED,
      ),
    ).not.toThrow();
    expect(() =>
      assertPaymentOrderTransition(
        PaymentOrderStatus.PENDING,
        PaymentOrderStatus.CANCELLED,
      ),
    ).not.toThrow();
  });

  it('allows idempotent terminal replay', () => {
    expect(() =>
      assertPaymentOrderTransition(
        PaymentOrderStatus.SUCCESS,
        PaymentOrderStatus.SUCCESS,
      ),
    ).not.toThrow();
    expect(() =>
      assertPaymentOrderTransition(
        PaymentOrderStatus.FAILED,
        PaymentOrderStatus.FAILED,
      ),
    ).not.toThrow();
  });

  it('rejects terminal cross transitions', () => {
    expect(() =>
      assertPaymentOrderTransition(
        PaymentOrderStatus.SUCCESS,
        PaymentOrderStatus.FAILED,
      ),
    ).toThrow(PaymentOrderTerminalStateError);
    expect(() =>
      assertPaymentOrderTransition(
        PaymentOrderStatus.FAILED,
        PaymentOrderStatus.SUCCESS,
      ),
    ).toThrow(PaymentOrderTerminalStateError);
    expect(() =>
      assertPaymentOrderTransition(
        PaymentOrderStatus.CANCELLED,
        PaymentOrderStatus.SUCCESS,
      ),
    ).toThrow(PaymentOrderTerminalStateError);
  });
});
