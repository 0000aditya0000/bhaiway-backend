import {
  Injectable,
  Logger,
  NotImplementedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import Razorpay from 'razorpay';

import { coinsToPaise, paiseToCoins } from './payment-amount.util';
import { PaymentGatewayPort } from './payment-gateway.port';
import {
  CreateOrderInput,
  CreateOrderResult,
  PaymentGatewayStatus,
  PaymentStatusResult,
  VerifyCallbackInput,
  VerifyCallbackResult,
  VerifyClientPaymentInput,
  VerifyClientPaymentResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from './payment-gateway.types';

export const RAZORPAY_SIGNATURE_HEADER = 'x-razorpay-signature';

function normalizeHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name];
  if (typeof direct === 'string') {
    return direct;
  }
  const lower = headers[name.toLowerCase()];
  if (typeof lower === 'string') {
    return lower;
  }
  if (Array.isArray(lower) && lower.length > 0) {
    return lower[0];
  }
  return undefined;
}

@Injectable()
export class RazorpayPaymentGateway implements PaymentGatewayPort {
  private readonly logger = new Logger(RazorpayPaymentGateway.name);
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly client: Razorpay;

  constructor(private readonly configService: ConfigService) {
    const keyId = this.configService.get<string>('RAZORPAY_KEY_ID')?.trim();
    const keySecret = this.configService.get<string>('RAZORPAY_KEY_SECRET')?.trim();
    const webhookSecret = this.configService.get<string>('RAZORPAY_WEBHOOK_SECRET')?.trim();

    if (!keyId || !keySecret || !webhookSecret) {
      throw new Error(
        'Missing required Razorpay configuration: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, and RAZORPAY_WEBHOOK_SECRET must be set when PAYMENT_GATEWAY_PROVIDER is razorpay',
      );
    }

    this.keyId = keyId;
    this.keySecret = keySecret;
    this.webhookSecret = webhookSecret;

    this.client = new Razorpay({
      key_id: this.keyId,
      key_secret: this.keySecret,
    });
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const amountInPaise = coinsToPaise(input.amount);

    try {
      const order = await this.client.orders.create({
        amount: amountInPaise,
        currency: input.currency,
        receipt: input.internalOrderId,
        notes: {
          userId: input.userId,
          internalOrderId: input.internalOrderId,
        },
      });

      this.logger.log(
        `Razorpay order created gatewayOrderId=${order.id} for internalOrder=${input.internalOrderId}`,
      );

      return {
        gatewayOrderId: order.id,
        paymentReference: order.id,
        keyId: this.keyId,
      };
    } catch (error) {
      this.logger.error(
        `Razorpay order creation failed for internalOrder=${input.internalOrderId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  async verifyClientPayment(
    input: VerifyClientPaymentInput,
  ): Promise<VerifyClientPaymentResult> {
    const bodyToSign = `${input.gatewayOrderId}|${input.gatewayPaymentId}`;
    const expected = createHmac('sha256', this.keySecret)
      .update(bodyToSign)
      .digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(input.signature, 'hex');

    if (
      expectedBuf.length === 0 ||
      providedBuf.length === 0 ||
      expectedBuf.length !== providedBuf.length
    ) {
      return {
        valid: false,
        gatewayOrderId: input.gatewayOrderId,
        gatewayPaymentId: input.gatewayPaymentId,
        amount: '0',
        currency: 'INR',
        status: PaymentGatewayStatus.FAILED,
        rawStatus: 'invalid_signature',
      };
    }

    const valid = timingSafeEqual(expectedBuf, providedBuf);
    if (!valid) {
      return {
        valid: false,
        gatewayOrderId: input.gatewayOrderId,
        gatewayPaymentId: input.gatewayPaymentId,
        amount: '0',
        currency: 'INR',
        status: PaymentGatewayStatus.FAILED,
        rawStatus: 'signature_mismatch',
      };
    }

    // Retrieve payment details from Razorpay to verify state, amount, and currency
    try {
      const payment = await this.client.payments.fetch(input.gatewayPaymentId);
      const paymentOrderId = payment.order_id;
      const isCaptured = payment.status === 'captured';
      const amountCoins = paiseToCoins(payment.amount);

      const status = isCaptured
        ? PaymentGatewayStatus.SUCCESS
        : payment.status === 'authorized'
          ? PaymentGatewayStatus.AUTHORIZED
          : PaymentGatewayStatus.FAILED;

      const orderMatches = paymentOrderId === input.gatewayOrderId;

      return {
        valid: valid && orderMatches,
        gatewayOrderId: input.gatewayOrderId,
        gatewayPaymentId: input.gatewayPaymentId,
        amount: amountCoins,
        currency: payment.currency,
        status: orderMatches ? status : PaymentGatewayStatus.FAILED,
        rawStatus: payment.status,
      };
    } catch (error) {
      this.logger.error(
        `Failed to fetch payment details from Razorpay for paymentId=${input.gatewayPaymentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        valid: false,
        gatewayOrderId: input.gatewayOrderId,
        gatewayPaymentId: input.gatewayPaymentId,
        amount: '0',
        currency: 'INR',
        status: PaymentGatewayStatus.FAILED,
        rawStatus: 'fetch_failed',
      };
    }
  }

  async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
    const signature = normalizeHeader(input.headers, RAZORPAY_SIGNATURE_HEADER);
    if (!signature) {
      return {
        valid: false,
        eventId: '',
        eventType: '',
        status: PaymentGatewayStatus.FAILED,
      };
    }

    const rawBuffer = Buffer.isBuffer(input.rawBody)
      ? input.rawBody
      : Buffer.from(input.rawBody, 'utf8');

    const expected = createHmac('sha256', this.webhookSecret)
      .update(rawBuffer)
      .digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(signature, 'hex');

    if (
      expectedBuf.length === 0 ||
      providedBuf.length === 0 ||
      expectedBuf.length !== providedBuf.length ||
      !timingSafeEqual(expectedBuf, providedBuf)
    ) {
      return {
        valid: false,
        eventId: '',
        eventType: '',
        status: PaymentGatewayStatus.FAILED,
      };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBuffer.toString('utf8'));
    } catch {
      return {
        valid: false,
        eventId: '',
        eventType: '',
        status: PaymentGatewayStatus.FAILED,
      };
    }

    const eventId =
      (parsed.id as string) ||
      (parsed.event_id as string) ||
      `evt_${Date.now()}`;
    const eventType = (parsed.event as string) || '';
    const payloadObj = parsed.payload as Record<string, unknown> | undefined;
    const paymentObj = (payloadObj?.payment as Record<string, unknown> | undefined)?.entity as
      | Record<string, unknown>
      | undefined;
    const orderObj = (payloadObj?.order as Record<string, unknown> | undefined)?.entity as
      | Record<string, unknown>
      | undefined;

    const gatewayOrderId =
      (paymentObj?.order_id as string) || (orderObj?.id as string) || undefined;
    const gatewayPaymentId = paymentObj?.id as string | undefined;

    let amount = '0';
    if (paymentObj?.amount !== undefined) {
      try {
        amount = paiseToCoins(paymentObj.amount as number | string | bigint);
      } catch {
        amount = '0';
      }
    } else if (orderObj?.amount_paid !== undefined) {
      try {
        amount = paiseToCoins(orderObj.amount_paid as number | string | bigint);
      } catch {
        amount = '0';
      }
    }

    const currency =
      (paymentObj?.currency as string) || (orderObj?.currency as string) || 'INR';

    let status = PaymentGatewayStatus.FAILED;
    let rawStatus = (paymentObj?.status as string) || (orderObj?.status as string) || '';

    if (eventType === 'payment.captured' || (eventType === 'order.paid' && paymentObj?.status === 'captured')) {
      status = PaymentGatewayStatus.SUCCESS;
      rawStatus = 'captured';
    } else if (eventType === 'payment.authorized') {
      status = PaymentGatewayStatus.AUTHORIZED;
      rawStatus = 'authorized';
    } else if (eventType === 'payment.failed') {
      status = PaymentGatewayStatus.FAILED;
      rawStatus = 'failed';
    }

    return {
      valid: true,
      eventId,
      eventType,
      gatewayOrderId,
      gatewayPaymentId,
      amount,
      currency,
      status,
      rawStatus,
      payload: parsed,
    };
  }

  async verifyCallback(
    input: VerifyCallbackInput,
  ): Promise<VerifyCallbackResult> {
    // Standard mock-style callback compatibility
    return {
      valid: false,
      gatewayOrderId: '',
      amount: '0',
      currency: 'INR',
      status: PaymentGatewayStatus.FAILED,
    };
  }

  async getPaymentStatus(gatewayOrderId: string): Promise<PaymentStatusResult> {
    try {
      const order = await this.client.orders.fetch(gatewayOrderId);
      const isPaid = order.status === 'paid';
      const amountCoins = paiseToCoins(order.amount);

      return {
        gatewayOrderId,
        amount: amountCoins,
        currency: order.currency,
        status: isPaid ? PaymentGatewayStatus.SUCCESS : PaymentGatewayStatus.FAILED,
      };
    } catch {
      return {
        gatewayOrderId,
        amount: '0',
        currency: 'INR',
        status: PaymentGatewayStatus.FAILED,
      };
    }
  }

  async refund(): Promise<never> {
    throw new NotImplementedException(
      'External gateway refunds are not supported',
    );
  }
}
