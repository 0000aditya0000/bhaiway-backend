import { PaymentOrderStatus } from '../enums/payment-order.enums';

/** Normalized gateway payment status (maps to PaymentOrderStatus terminal states). */
export enum PaymentGatewayStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  AUTHORIZED = 'AUTHORIZED',
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
  keyId?: string;
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

export interface VerifyClientPaymentInput {
  gatewayOrderId: string;
  gatewayPaymentId: string;
  signature: string;
}

export interface VerifyClientPaymentResult {
  valid: boolean;
  gatewayOrderId: string;
  gatewayPaymentId: string;
  amount: string;
  currency: string;
  status: PaymentGatewayStatus;
  rawStatus?: string;
}

export interface VerifyWebhookInput {
  rawBody: Buffer | string;
  headers: Record<string, string | string[] | undefined>;
}

export interface VerifyWebhookResult {
  valid: boolean;
  eventId: string;
  eventType: string;
  gatewayOrderId?: string;
  gatewayPaymentId?: string;
  amount?: string;
  currency?: string;
  status: PaymentGatewayStatus;
  rawStatus?: string;
  payload?: Record<string, unknown>;
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
    case PaymentGatewayStatus.AUTHORIZED:
      return PaymentOrderStatus.PENDING;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
