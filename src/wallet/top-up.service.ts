import {
  BadRequestException,
  Inject,
  Injectable,
} from '@nestjs/common';
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
import { PaymentOrder } from './entities/payment-order.entity';
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
import {
  WalletTransactionType,
} from './entities/wallet-transaction.entity';
import { Wallet } from './entities/wallet.entity';
import {
  MOCK_CALLBACK_PATH,
  MOCK_SIGNATURE_HEADER,
} from './payment/mock-payment.gateway';
import { PAYMENT_GATEWAY } from './payment/payment-gateway.port';
import type { PaymentGatewayPort } from './payment/payment-gateway.port';
import { mapGatewayStatusToPaymentOrderStatus } from './payment/payment-gateway.types';
import {
  PAYMENT_ORDER_REFERENCE_TYPE,
  TOP_UP_CREDIT_IDEMPOTENCY_PREFIX,
} from './wallet.constants';
import { parsePositiveIntegerAmount } from './wallet-amount.util';
import { assertWalletAllowsTopUp } from './wallet-status.util';
import { WalletService } from './wallet.service';

@Injectable()
export class TopUpService {
  private static readonly IDEMPOTENCY_CONSTRAINT =
    'UQ_payment_orders_idempotency_key';

  constructor(
    private readonly dataSource: DataSource,
    private readonly walletService: WalletService,
    @Inject(PAYMENT_GATEWAY)
    private readonly paymentGateway: PaymentGatewayPort,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @InjectRepository(PaymentOrder)
    private readonly paymentOrderRepository: Repository<PaymentOrder>,
  ) {}

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

    const existing = await this.paymentOrderRepository.findOne({
      where: { idempotencyKey: key },
    });
    if (existing) {
      this.assertIdempotentTopUpMatches(existing, userId, amountString);
      return this.toOrderResponse(existing);
    }

    const wallet = await this.walletRepository.findOne({
      where: { userId },
    });
    if (!wallet) {
      throw new WalletNotFoundError();
    }
    assertWalletAllowsTopUp(wallet);

    try {
      const order = await this.dataSource.transaction(async (manager) => {
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

        const pendingOrder = manager.create(PaymentOrder, {
          userId,
          walletId: wallet.id,
          amount: amountString,
          currency: 'INR',
          provider: PaymentOrderProvider.MOCK,
          status: PaymentOrderStatus.PENDING,
          gatewayOrderId: null,
          idempotencyKey: key,
          walletTransactionId: null,
          callbackReference: null,
        });
        const savedOrder = await manager.save(PaymentOrder, pendingOrder);

        const gatewayOrder = await this.paymentGateway.createOrder({
          amount: amountString,
          currency: 'INR',
          userId,
          internalOrderId: savedOrder.id,
        });

        savedOrder.gatewayOrderId = gatewayOrder.gatewayOrderId;
        return manager.save(PaymentOrder, savedOrder);
      });

      return this.toOrderResponse(order);
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

  private toOrderResponse(order: PaymentOrder): TopUpOrderResponseDto {
    const hasGatewayOrder = Boolean(order.gatewayOrderId);

    return {
      paymentOrderId: order.id,
      amount: order.amount,
      currency: order.currency,
      status: order.status,
      provider: order.provider,
      gatewayOrderId: order.gatewayOrderId ?? '',
      paymentReference: hasGatewayOrder
        ? `mock_ref_${order.id}`
        : undefined,
      mockInstructions: hasGatewayOrder
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
