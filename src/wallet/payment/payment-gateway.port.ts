import {
  CreateOrderInput,
  CreateOrderResult,
  PaymentStatusResult,
  VerifyCallbackInput,
  VerifyCallbackResult,
  VerifyClientPaymentInput,
  VerifyClientPaymentResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from './payment-gateway.types';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/**
 * Provider-agnostic payment gateway boundary.
 * Implementations must not depend on wallet entities or WalletService.
 */
export interface PaymentGatewayPort {
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;

  verifyCallback(input: VerifyCallbackInput): Promise<VerifyCallbackResult>;

  verifyClientPayment(
    input: VerifyClientPaymentInput,
  ): Promise<VerifyClientPaymentResult>;

  verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult>;

  getPaymentStatus(gatewayOrderId: string): Promise<PaymentStatusResult>;

  refund(
    gatewayOrderId: string,
    amount: string,
    reason?: string,
  ): Promise<never>;
}
