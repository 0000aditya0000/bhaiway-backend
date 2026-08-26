import { Injectable, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

import { PaymentGatewayPort } from './payment-gateway.port';
import {
  CreateOrderInput,
  CreateOrderResult,
  PaymentGatewayStatus,
  PaymentStatusResult,
  VerifyCallbackInput,
  VerifyCallbackResult,
} from './payment-gateway.types';

/**
 * Mock payment gateway for local/dev top-up flows.
 *
 * A future real-gateway adapter must still implement PaymentGatewayPort and provide:
 * - provider-specific signature verification (not this HMAC-only mock)
 * - webhook secret rotation support
 * - stable gateway/payment/event identifiers
 * - timestamp/nonce or event-id replay protection (may require schema support)
 * - provider status → PaymentGatewayStatus mapping
 *
 * This mock intentionally does NOT implement IP allowlisting or provider replay windows.
 */

export const MOCK_CALLBACK_PATH = '/wallet/top-up/callback';
export const MOCK_SIGNATURE_HEADER = 'x-payment-signature';

interface MockCallbackPayload {
  gatewayOrderId: string;
  amount: string;
  currency: string;
  status: PaymentGatewayStatus;
  reference?: string;
}

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

export function buildMockCallbackSigningPayload(
  payload: MockCallbackPayload,
): Record<string, string> {
  const canonical: Record<string, string> = {
    amount: payload.amount,
    currency: payload.currency,
    gatewayOrderId: payload.gatewayOrderId,
    status: payload.status,
  };
  if (payload.reference !== undefined) {
    canonical.reference = payload.reference;
  }
  return canonical;
}

export function signMockCallbackPayload(
  payload: MockCallbackPayload,
  secret: string,
): string {
  const canonical = buildMockCallbackSigningPayload(payload);
  const message = Object.keys(canonical)
    .sort()
    .map((key) => `${key}=${canonical[key]}`)
    .join('&');

  return createHmac('sha256', secret).update(message).digest('hex');
}

function verifySignature(
  payload: MockCallbackPayload,
  signature: string,
  secret: string,
): boolean {
  const expected = signMockCallbackPayload(payload, secret);
  const expectedBuffer = Buffer.from(expected, 'hex');
  const providedBuffer = Buffer.from(signature, 'hex');

  if (
    expectedBuffer.length === 0 ||
    expectedBuffer.length !== providedBuffer.length
  ) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function isMockCallbackPayload(value: unknown): value is MockCallbackPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.gatewayOrderId === 'string' &&
    typeof record.amount === 'string' &&
    typeof record.currency === 'string' &&
    (record.status === PaymentGatewayStatus.SUCCESS ||
      record.status === PaymentGatewayStatus.FAILED ||
      record.status === PaymentGatewayStatus.CANCELLED) &&
    (record.reference === undefined || typeof record.reference === 'string')
  );
}

@Injectable()
export class MockPaymentGateway implements PaymentGatewayPort {
  constructor(private readonly configService: ConfigService) {}

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const gatewayOrderId = `mock_${input.internalOrderId}`;
    const paymentReference = `mock_ref_${input.internalOrderId}`;

    return {
      gatewayOrderId,
      paymentReference,
      mockInstructions: {
        callbackPath: MOCK_CALLBACK_PATH,
        signatureHeader: MOCK_SIGNATURE_HEADER,
        note:
          'POST a signed callback payload to complete the mock payment. Signature is HMAC-SHA256 over sorted key=value pairs using PAYMENT_GATEWAY_WEBHOOK_SECRET.',
      },
    };
  }

  async verifyCallback(
    input: VerifyCallbackInput,
  ): Promise<VerifyCallbackResult> {
    if (!isMockCallbackPayload(input.payload)) {
      return {
        valid: false,
        gatewayOrderId: '',
        amount: '0',
        currency: '',
        status: PaymentGatewayStatus.FAILED,
      };
    }

    const signature = normalizeHeader(input.headers, MOCK_SIGNATURE_HEADER);
    const secret = this.configService.get<string>(
      'PAYMENT_GATEWAY_WEBHOOK_SECRET',
    );

    if (!signature || !secret) {
      return {
        valid: false,
        gatewayOrderId: input.payload.gatewayOrderId,
        amount: input.payload.amount,
        currency: input.payload.currency,
        status: input.payload.status,
      };
    }

    const valid = verifySignature(input.payload, signature, secret);
    return {
      valid,
      gatewayOrderId: input.payload.gatewayOrderId,
      amount: input.payload.amount,
      currency: input.payload.currency,
      status: input.payload.status,
      reference: input.payload.reference,
    };
  }

  async getPaymentStatus(gatewayOrderId: string): Promise<PaymentStatusResult> {
    return {
      gatewayOrderId,
      amount: '0',
      currency: 'INR',
      status: PaymentGatewayStatus.FAILED,
    };
  }

  async refund(): Promise<never> {
    throw new NotImplementedException('Refunds are not implemented');
  }
}
