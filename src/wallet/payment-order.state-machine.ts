import { PaymentOrderStatus } from './enums/payment-order.enums';
import { PaymentOrderTerminalStateError } from './errors/top-up.errors';

const TERMINAL_PAYMENT_ORDER_STATUSES: ReadonlySet<PaymentOrderStatus> =
  new Set([
    PaymentOrderStatus.SUCCESS,
    PaymentOrderStatus.FAILED,
    PaymentOrderStatus.CANCELLED,
  ]);

const PENDING_TRANSITIONS: ReadonlySet<PaymentOrderStatus> = new Set([
  PaymentOrderStatus.SUCCESS,
  PaymentOrderStatus.FAILED,
  PaymentOrderStatus.CANCELLED,
]);

export function isTerminalPaymentOrderStatus(
  status: PaymentOrderStatus,
): boolean {
  return TERMINAL_PAYMENT_ORDER_STATUSES.has(status);
}

/**
 * Enforces:
 * PENDING -> SUCCESS | FAILED | CANCELLED
 * terminal -> same terminal (idempotent replay)
 * terminal -> different terminal (rejected)
 */
export function assertPaymentOrderTransition(
  current: PaymentOrderStatus,
  next: PaymentOrderStatus,
): void {
  if (current === next) {
    return;
  }

  if (isTerminalPaymentOrderStatus(current)) {
    throw new PaymentOrderTerminalStateError(
      `Payment order in terminal state ${current} cannot transition to ${next}`,
    );
  }

  if (current === PaymentOrderStatus.PENDING && PENDING_TRANSITIONS.has(next)) {
    return;
  }

  throw new PaymentOrderTerminalStateError(
    `Invalid payment order transition: ${current} -> ${next}`,
  );
}
