import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';

import { CreateTopUpDto } from './dto/create-top-up.dto';
import { TopUpCallbackDto } from './dto/top-up-callback.dto';
import { TopUpOrderResponseDto } from './dto/top-up-order-response.dto';
import { VerifyTopUpDto } from './dto/verify-top-up.dto';
import { PaymentOrder } from './entities/payment-order.entity';
import {
  PaymentWebhookEvent,
  WebhookProcessingStatus,
} from './entities/payment-webhook-event.entity';
import {
  PaymentOrderProvider,
  PaymentOrderStatus,
} from './enums/payment-order.enums';
import {
  InvalidPaymentCallbackError,
  PaymentCallbackAmountMismatchError,
  PaymentCallbackCurrencyMismatchError,
  PaymentOrderNotFoundError,
  PaymentOrderTerminalStateError,
  TopUpIdempotencyConflictError,
} from './errors/top-up.errors';
import { WalletNotFoundError } from './errors/wallet.errors';
import { assertPaymentOrderTransition } from './payment-order.state-machine';
import { WalletPointSource } from './entities/wallet-point-lot.entity';
import { WalletTransactionType } from './entities/wallet-transaction.entity';
import { Wallet } from './entities/wallet.entity';
import {
  MOCK_CALLBACK_PATH,
  MOCK_SIGNATURE_HEADER,
} from './payment/mock-payment.gateway';
import { PAYMENT_GATEWAY } from './payment/payment-gateway.port';
import type { PaymentGatewayPort } from './payment/payment-gateway.port';
import {
  PaymentGatewayStatus,
  mapGatewayStatusToPaymentOrderStatus,
} from './payment/payment-gateway.types';
import {
  PAYMENT_ORDER_REFERENCE_TYPE,
  TOP_UP_CREDIT_IDEMPOTENCY_PREFIX,
} from './wallet.constants';
import { parsePositiveIntegerAmount } from './wallet-amount.util';
import { assertWalletAllowsTopUp } from './wallet-status.util';
import { WalletService } from './wallet.service';

@Injectable()
export class TopUpService {
  private readonly logger = new Logger(TopUpService.name);

  private static readonly IDEMPOTENCY_CONSTRAINT =
    'UQ_payment_orders_idempotency_key';

  constructor(
    private readonly dataSource: DataSource,
    private readonly walletService: WalletService,
    private readonly configService: ConfigService,
    @Inject(PAYMENT_GATEWAY)
    private readonly paymentGateway: PaymentGatewayPort,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @InjectRepository(PaymentOrder)
    private readonly paymentOrderRepository: Repository<PaymentOrder>,
    @InjectRepository(PaymentWebhookEvent)
    private readonly webhookEventRepository: Repository<PaymentWebhookEvent>,
  ) {}

  private getActiveProvider(): PaymentOrderProvider {
    const providerName = this.configService
      .get<string>('PAYMENT_GATEWAY_PROVIDER', 'mock')
      ?.trim()
      .toLowerCase();
    return providerName === 'razorpay'
      ? PaymentOrderProvider.RAZORPAY
      : PaymentOrderProvider.MOCK;
  }

  async createTopUp(
    userId: string,
    dto: CreateTopUpDto,
    idempotencyKey: string | undefined,
  ): Promise<TopUpOrderResponseDto> {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException(
        'Idempotency-Key header is required for wallet top-up',
      );
    }

    const key = idempotencyKey.trim();
    if (key.length > 255) {
      throw new BadRequestException(
        'Idempotency-Key must be at most 255 characters',
      );
    }

    const amount = parsePositiveIntegerAmount(dto.amount);
    const amountString = amount.toString();

    // 1. Check existing order by idempotency key
    const existing = await this.paymentOrderRepository.findOne({
      where: { idempotencyKey: key },
    });
    if (existing) {
      this.assertIdempotentTopUpMatches(existing, userId, amountString);
      if (existing.gatewayOrderId) {
        return this.toOrderResponse(existing);
      }
    }

    const wallet = await this.walletRepository.findOne({
      where: { userId },
    });
    if (!wallet) {
      throw new WalletNotFoundError();
    }
    assertWalletAllowsTopUp(wallet);

    const activeProvider = this.getActiveProvider();

    // 2. Short DB Transaction 1: Create internal PaymentOrder in PENDING state
    let pendingOrder: PaymentOrder;
    try {
      pendingOrder = await this.dataSource.transaction(async (manager) => {
        const existingInTx = await manager.findOne(PaymentOrder, {
          where: { idempotencyKey: key },
        });
        if (existingInTx) {
          this.assertIdempotentTopUpMatches(
            existingInTx,
            userId,
            amountString,
          );
          return existingInTx;
        }

        const newOrder = manager.create(PaymentOrder, {
          userId,
          walletId: wallet.id,
          amount: amountString,
          currency: 'INR',
          provider: activeProvider,
          status: PaymentOrderStatus.PENDING,
          gatewayOrderId: null,
          idempotencyKey: key,
          walletTransactionId: null,
          callbackReference: null,
          gatewayPaymentId: null,
          gatewaySignature: null,
          gatewayStatus: null,
          failureReason: null,
          metadata: null,
        });

        return manager.save(PaymentOrder, newOrder);
      });
    } catch (error) {
      if (this.isPaymentOrderIdempotencyConflict(error)) {
        const recovered = await this.paymentOrderRepository.findOne({
          where: { idempotencyKey: key },
        });
        if (recovered) {
          this.assertIdempotentTopUpMatches(recovered, userId, amountString);
          return this.toOrderResponse(recovered);
        }
      }
      throw error;
    }

    if (pendingOrder.gatewayOrderId) {
      return this.toOrderResponse(pendingOrder);
    }

    // 3. Outside DB Transaction: Network call to Payment Gateway
    let gatewayOrderResult;
    try {
      gatewayOrderResult = await this.paymentGateway.createOrder({
        amount: amountString,
        currency: 'INR',
        userId,
        internalOrderId: pendingOrder.id,
      });
    } catch (gatewayError) {
      const errMsg =
        gatewayError instanceof Error
          ? gatewayError.message
          : String(gatewayError);

      this.logger.error(
        `Payment gateway order creation failed orderId=${pendingOrder.id}: ${errMsg}`,
      );

      // Short DB update: record failure state without crediting
      await this.paymentOrderRepository.update(pendingOrder.id, {
        status: PaymentOrderStatus.FAILED,
        failureReason: errMsg.slice(0, 255),
      });

      throw gatewayError;
    }

    // 4. Short DB Transaction 2: Lock and update PaymentOrder with gateway details
    const updatedOrder = await this.dataSource.transaction(async (manager) => {
      const orderToUpdate = await manager
        .createQueryBuilder(PaymentOrder, 'po')
        .setLock('pessimistic_write')
        .where('po.id = :id', { id: pendingOrder.id })
        .getOne();

      if (!orderToUpdate) {
        throw new PaymentOrderNotFoundError();
      }

      if (orderToUpdate.status === PaymentOrderStatus.PENDING) {
        orderToUpdate.gatewayOrderId = gatewayOrderResult.gatewayOrderId;
        if (gatewayOrderResult.keyId) {
          orderToUpdate.metadata = {
            ...(orderToUpdate.metadata ?? {}),
            keyId: gatewayOrderResult.keyId,
          };
        }
        return manager.save(PaymentOrder, orderToUpdate);
      }

      return orderToUpdate;
    });

    return this.toOrderResponse(updatedOrder, gatewayOrderResult.keyId);
  }

  async getTopUpOrderForUser(
    userId: string,
    paymentOrderId: string,
  ): Promise<TopUpOrderResponseDto> {
    const order = await this.paymentOrderRepository.findOne({
      where: { id: paymentOrderId },
    });
    if (!order || order.userId !== userId) {
      throw new PaymentOrderNotFoundError();
    }
    return this.toOrderResponse(order);
  }

  /**
   * Client-side Razorpay Checkout completion verification.
   * Authenticated with user JWT. Server verifies checkout signature and payment state.
   */
  async verifyClientPayment(
    userId: string,
    dto: VerifyTopUpDto,
  ): Promise<TopUpOrderResponseDto> {
    const order = await this.paymentOrderRepository.findOne({
      where: { gatewayOrderId: dto.razorpay_order_id },
    });

    if (!order) {
      throw new PaymentOrderNotFoundError('Payment order not found for gateway order ID');
    }

    if (order.userId !== userId) {
      throw new PaymentOrderNotFoundError('Payment order not found for user');
    }

    const verified = await this.paymentGateway.verifyClientPayment({
      gatewayOrderId: dto.razorpay_order_id,
      gatewayPaymentId: dto.razorpay_payment_id,
      signature: dto.razorpay_signature,
    });

    if (!verified.valid) {
      throw new InvalidPaymentCallbackError('Invalid payment checkout signature');
    }

    if (verified.status !== PaymentGatewayStatus.SUCCESS) {
      throw new PaymentOrderTerminalStateError(
        `Payment is in uncaptured state: ${verified.rawStatus ?? verified.status}`,
      );
    }

    // Atomic credit inside DB transaction
    return this.dataSource.transaction(async (manager) => {
      const lockedOrder = await manager
        .createQueryBuilder(PaymentOrder, 'po')
        .setLock('pessimistic_write')
        .where('po.id = :id', { id: order.id })
        .getOne();

      if (!lockedOrder) {
        throw new PaymentOrderNotFoundError();
      }

      // Idempotent check: already completed
      if (lockedOrder.status === PaymentOrderStatus.SUCCESS) {
        this.assertSuccessfulOrderIntegrity(lockedOrder);
        return this.toOrderResponse(lockedOrder);
      }

      assertPaymentOrderTransition(
        lockedOrder.status,
        PaymentOrderStatus.SUCCESS,
      );

      const creditResult = await this.walletService.creditPointsInTransaction(
        manager,
        {
          walletId: lockedOrder.walletId,
          userId: lockedOrder.userId,
          amount: BigInt(lockedOrder.amount),
          sourceType: WalletPointSource.PURCHASED,
          transactionType: WalletTransactionType.POINT_PURCHASE,
          referenceType: PAYMENT_ORDER_REFERENCE_TYPE,
          referenceId: lockedOrder.id,
          idempotencyKey: `${TOP_UP_CREDIT_IDEMPOTENCY_PREFIX}${lockedOrder.id}`,
        },
      );

      lockedOrder.status = PaymentOrderStatus.SUCCESS;
      lockedOrder.gatewayPaymentId = dto.razorpay_payment_id;
      lockedOrder.gatewaySignature = dto.razorpay_signature;
      lockedOrder.gatewayStatus = verified.rawStatus ?? 'captured';
      lockedOrder.walletTransactionId = creditResult.transaction.id;
      lockedOrder.callbackReference = dto.razorpay_payment_id;

      await manager.save(PaymentOrder, lockedOrder);

      this.logger.log(
        `Top-up payment verified and credited orderId=${lockedOrder.id} paymentId=${dto.razorpay_payment_id}`,
      );

      return this.toOrderResponse(lockedOrder);
    });
  }

  /**
   * Provider-agnostic gateway webhook processor.
   * Public route: POST /api/payments/gateway/webhook.
   */
  async processGatewayWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ received: boolean; status?: string }> {
    const verified = await this.paymentGateway.verifyWebhook({
      rawBody,
      headers,
    });

    if (!verified.valid) {
      throw new InvalidPaymentCallbackError('Invalid gateway webhook signature');
    }

    const activeProvider = this.getActiveProvider();

    // 1. Webhook Deduplication: Check if event was already processed
    const existingEvent = await this.webhookEventRepository.findOne({
      where: { provider: activeProvider, eventId: verified.eventId },
    });

    if (
      existingEvent &&
      existingEvent.status === WebhookProcessingStatus.PROCESSED
    ) {
      this.logger.log(
        `Webhook event already processed provider=${activeProvider} eventId=${verified.eventId}`,
      );
      return { received: true, status: 'already_processed' };
    }

    // Record webhook event in PENDING state (handles concurrency via unique index)
    let webhookEvent = existingEvent;
    if (!webhookEvent) {
      try {
        webhookEvent = await this.webhookEventRepository.save(
          this.webhookEventRepository.create({
            provider: activeProvider,
            eventId: verified.eventId,
            eventType: verified.eventType,
            status: WebhookProcessingStatus.PENDING,
            gatewayOrderId: verified.gatewayOrderId ?? null,
            gatewayPaymentId: verified.gatewayPaymentId ?? null,
            payload: verified.payload ?? null,
            failureReason: null,
            processedAt: null,
          }),
        );
      } catch (insertError) {
        const recovered = await this.webhookEventRepository.findOne({
          where: { provider: activeProvider, eventId: verified.eventId },
        });
        if (recovered && recovered.status === WebhookProcessingStatus.PROCESSED) {
          return { received: true, status: 'already_processed' };
        }
        webhookEvent = recovered;
      }
    }

    // 2. Handle specific webhook event types
    // Event: payment.authorized (pre-auth; DO NOT credit wallet)
    if (verified.status === PaymentGatewayStatus.AUTHORIZED) {
      if (verified.gatewayOrderId) {
        await this.paymentOrderRepository.update(
          { gatewayOrderId: verified.gatewayOrderId },
          {
            gatewayStatus: 'authorized',
            gatewayPaymentId: verified.gatewayPaymentId ?? undefined,
          },
        );
      }

      if (webhookEvent) {
        await this.webhookEventRepository.update(webhookEvent.id, {
          status: WebhookProcessingStatus.PROCESSED,
          processedAt: new Date(),
        });
      }
      return { received: true, status: 'authorized_acknowledged' };
    }

    // Event: payment.failed
    if (verified.eventType === 'payment.failed') {
      if (verified.gatewayOrderId) {
        await this.dataSource.transaction(async (manager) => {
          const order = await this.lockPaymentOrderByGatewayId(
            manager,
            verified.gatewayOrderId!,
          );
          if (order && order.status === PaymentOrderStatus.PENDING) {
            order.status = PaymentOrderStatus.FAILED;
            order.gatewayStatus = 'failed';
            order.gatewayPaymentId =
              verified.gatewayPaymentId ?? order.gatewayPaymentId;
            await manager.save(PaymentOrder, order);
          }
        });
      }

      if (webhookEvent) {
        await this.webhookEventRepository.update(webhookEvent.id, {
          status: WebhookProcessingStatus.PROCESSED,
          processedAt: new Date(),
        });
      }
      return { received: true, status: 'failed_acknowledged' };
    }

    // Event: payment.captured or order.paid with captured payment -> ATOMIC CREDIT
    if (verified.status === PaymentGatewayStatus.SUCCESS) {
      if (!verified.gatewayOrderId) {
        if (webhookEvent) {
          await this.webhookEventRepository.update(webhookEvent.id, {
            status: WebhookProcessingStatus.FAILED,
            failureReason: 'Missing gatewayOrderId in webhook payload',
          });
        }
        throw new BadRequestException('Webhook payload missing gatewayOrderId');
      }

      await this.dataSource.transaction(async (manager) => {
        const order = await this.lockPaymentOrderByGatewayId(
          manager,
          verified.gatewayOrderId!,
        );

        if (!order) {
          throw new PaymentOrderNotFoundError();
        }

        // Amount & currency verification against authoritative order
        if (verified.amount && verified.amount !== '0') {
          if (order.amount !== verified.amount) {
            throw new PaymentCallbackAmountMismatchError();
          }
        }
        if (verified.currency && order.currency !== verified.currency) {
          throw new PaymentCallbackCurrencyMismatchError();
        }

        // Idempotent duplicate: already success
        if (order.status === PaymentOrderStatus.SUCCESS) {
          this.assertSuccessfulOrderIntegrity(order);
          return;
        }

        assertPaymentOrderTransition(
          order.status,
          PaymentOrderStatus.SUCCESS,
        );

        const creditResult =
          await this.walletService.creditPointsInTransaction(manager, {
            walletId: order.walletId,
            userId: order.userId,
            amount: BigInt(order.amount),
            sourceType: WalletPointSource.PURCHASED,
            transactionType: WalletTransactionType.POINT_PURCHASE,
            referenceType: PAYMENT_ORDER_REFERENCE_TYPE,
            referenceId: order.id,
            idempotencyKey: `${TOP_UP_CREDIT_IDEMPOTENCY_PREFIX}${order.id}`,
          });

        order.status = PaymentOrderStatus.SUCCESS;
        order.gatewayPaymentId =
          verified.gatewayPaymentId ?? order.gatewayPaymentId;
        order.gatewayStatus = verified.rawStatus ?? 'captured';
        order.walletTransactionId = creditResult.transaction.id;
        order.callbackReference =
          verified.gatewayPaymentId ?? order.callbackReference;

        await manager.save(PaymentOrder, order);
      });

      if (webhookEvent) {
        await this.webhookEventRepository.update(webhookEvent.id, {
          status: WebhookProcessingStatus.PROCESSED,
          processedAt: new Date(),
        });
      }

      return { received: true, status: 'captured_and_credited' };
    }

    // Other events (e.g. refund.created, dispute, etc.): safely acknowledge
    if (webhookEvent) {
      await this.webhookEventRepository.update(webhookEvent.id, {
        status: WebhookProcessingStatus.IGNORED,
        processedAt: new Date(),
      });
    }

    return { received: true, status: 'ignored' };
  }

  /**
   * Existing mock callback processor (preserved for tests and mock dev mode).
   */
  async processCallback(
    dto: TopUpCallbackDto,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<TopUpOrderResponseDto> {
    const verified = await this.paymentGateway.verifyCallback({
      payload: dto,
      headers,
    });

    if (!verified.valid) {
      throw new InvalidPaymentCallbackError();
    }

    const targetStatus = mapGatewayStatusToPaymentOrderStatus(verified.status);

    return this.dataSource.transaction(async (manager) => {
      const order = await this.lockPaymentOrderByGatewayId(
        manager,
        verified.gatewayOrderId,
      );
      if (!order) {
        throw new PaymentOrderNotFoundError();
      }

      this.assertCallbackMatchesOrder(order, verified);

      if (order.status === PaymentOrderStatus.SUCCESS) {
        this.assertSuccessfulOrderIntegrity(order);
        if (targetStatus !== PaymentOrderStatus.SUCCESS) {
          throw new PaymentOrderTerminalStateError();
        }
        return this.toOrderResponse(order);
      }

      assertPaymentOrderTransition(order.status, targetStatus);

      if (
        order.status === PaymentOrderStatus.FAILED ||
        order.status === PaymentOrderStatus.CANCELLED
      ) {
        order.callbackReference = verified.reference ?? order.callbackReference;
        await manager.save(PaymentOrder, order);
        return this.toOrderResponse(order);
      }

      if (targetStatus === PaymentOrderStatus.SUCCESS) {
        const creditResult = await this.walletService.creditPointsInTransaction(
          manager,
          {
            walletId: order.walletId,
            userId: order.userId,
            amount: BigInt(order.amount),
            sourceType: WalletPointSource.PURCHASED,
            transactionType: WalletTransactionType.POINT_PURCHASE,
            referenceType: PAYMENT_ORDER_REFERENCE_TYPE,
            referenceId: order.id,
            idempotencyKey: `${TOP_UP_CREDIT_IDEMPOTENCY_PREFIX}${order.id}`,
          },
        );

        order.status = PaymentOrderStatus.SUCCESS;
        order.walletTransactionId = creditResult.transaction.id;
        order.callbackReference = verified.reference ?? null;
        await manager.save(PaymentOrder, order);

        return this.toOrderResponse(order);
      }

      order.status = targetStatus;
      order.callbackReference = verified.reference ?? null;
      await manager.save(PaymentOrder, order);

      return this.toOrderResponse(order);
    });
  }

  private assertSuccessfulOrderIntegrity(order: PaymentOrder): void {
    if (!order.walletTransactionId) {
      throw new PaymentOrderTerminalStateError(
        'Successful payment order is missing wallet_transaction_id',
      );
    }
  }

  private assertIdempotentTopUpMatches(
    order: PaymentOrder,
    userId: string,
    amount: string,
  ): void {
    if (order.userId !== userId) {
      throw new TopUpIdempotencyConflictError(
        'Idempotency-Key is already used by another user',
      );
    }
    if (order.amount !== amount) {
      throw new TopUpIdempotencyConflictError();
    }
  }

  private assertCallbackMatchesOrder(
    order: PaymentOrder,
    verified: {
      gatewayOrderId: string;
      amount: string;
      currency: string;
    },
  ): void {
    if (order.gatewayOrderId !== verified.gatewayOrderId) {
      throw new PaymentOrderNotFoundError();
    }

    if (order.amount !== verified.amount) {
      throw new PaymentCallbackAmountMismatchError();
    }

    if (order.currency !== verified.currency) {
      throw new PaymentCallbackCurrencyMismatchError();
    }
  }

  private async lockPaymentOrderByGatewayId(
    manager: EntityManager,
    gatewayOrderId: string,
  ): Promise<PaymentOrder | null> {
    return manager
      .createQueryBuilder(PaymentOrder, 'paymentOrder')
      .setLock('pessimistic_write')
      .where('paymentOrder.gateway_order_id = :gatewayOrderId', {
        gatewayOrderId,
      })
      .getOne();
  }

  private toOrderResponse(
    order: PaymentOrder,
    keyId?: string,
  ): TopUpOrderResponseDto {
    const hasGatewayOrder = Boolean(order.gatewayOrderId);
    const resolvedKeyId =
      keyId ??
      ((order.metadata as Record<string, string> | null)?.keyId || undefined);

    return {
      paymentOrderId: order.id,
      amount: order.amount,
      currency: order.currency,
      status: order.status,
      provider: order.provider,
      gatewayOrderId: order.gatewayOrderId ?? '',
      keyId: resolvedKeyId,
      paymentReference: hasGatewayOrder
        ? (order.provider === PaymentOrderProvider.MOCK
            ? `mock_ref_${order.id}`
            : order.gatewayOrderId ?? undefined)
        : undefined,
      mockInstructions:
        order.provider === PaymentOrderProvider.MOCK && hasGatewayOrder
          ? {
              callbackPath: MOCK_CALLBACK_PATH,
              signatureHeader: MOCK_SIGNATURE_HEADER,
              note:
                'POST a signed callback payload to complete the mock payment. Signature is HMAC-SHA256 over sorted key=value pairs using PAYMENT_GATEWAY_WEBHOOK_SECRET.',
            }
          : undefined,
      walletTransactionId: order.walletTransactionId,
      callbackReference: order.callbackReference,
    };
  }

  private isPaymentOrderIdempotencyConflict(error: unknown): boolean {
    let current: unknown = error;
    while (current) {
      if (current instanceof QueryFailedError) {
        const driverError = current.driverError as {
          code?: string;
          constraint?: string;
        };
        if (
          driverError?.code === '23505' &&
          driverError.constraint === TopUpService.IDEMPOTENCY_CONSTRAINT
        ) {
          return true;
        }
      }

      if (typeof current === 'object' && current !== null) {
        const record = current as {
          code?: string;
          constraint?: string;
          driverError?: { code?: string; constraint?: string };
          cause?: unknown;
        };
        if (
          record.code === '23505' &&
          record.constraint === TopUpService.IDEMPOTENCY_CONSTRAINT
        ) {
          return true;
        }
        if (
          record.driverError?.code === '23505' &&
          record.driverError.constraint === TopUpService.IDEMPOTENCY_CONSTRAINT
        ) {
          return true;
        }
        current = record.cause;
        continue;
      }

      break;
    }

    return false;
  }
}
