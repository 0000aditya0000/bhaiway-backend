import { PaymentOrderStatus } from '../enums/payment-order.enums';

/** Normalized gateway payment status (maps to PaymentOrderStatus terminal states). */
export enum PaymentGatewayStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export interface CreateOrderInput {
  amount: string;
  currency: string;
  userId: string;
  internalOrderId: string;
}

export interface CreateOrderResult {
  gatewayOrderId: string;
  paymentReference: string;
  /** Mock-only hints for local/dev testing. Real gateways may return paymentUrl instead. */
  mockInstructions?: {
    callbackPath: string;
    signatureHeader: string;
    note: string;
  };
}

export interface VerifyCallbackInput {
  payload: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export interface VerifyCallbackResult {
  valid: boolean;
  gatewayOrderId: string;
  amount: string;
  currency: string;
  status: PaymentGatewayStatus;
  reference?: string;
}

export interface PaymentStatusResult {
  gatewayOrderId: string;
  amount: string;
  currency: string;
  status: PaymentGatewayStatus;
  reference?: string;
}

export function mapGatewayStatusToPaymentOrderStatus(
  status: PaymentGatewayStatus,
): PaymentOrderStatus {
  switch (status) {
    case PaymentGatewayStatus.SUCCESS:
      return PaymentOrderStatus.SUCCESS;
    case PaymentGatewayStatus.FAILED:
      return PaymentOrderStatus.FAILED;
    case PaymentGatewayStatus.CANCELLED:
      return PaymentOrderStatus.CANCELLED;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
