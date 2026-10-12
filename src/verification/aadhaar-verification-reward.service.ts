import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/enums/notification.enums';
import { WalletPointSource } from '../wallet/entities/wallet-point-lot.entity';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletNotFoundError } from '../wallet/errors/wallet.errors';
import { WalletService } from '../wallet/wallet.service';
import {
  AADHAAR_VERIFICATION_REFERENCE_TYPE,
  AADHAAR_VERIFICATION_REWARD_COINS,
  aadhaarVerificationRewardIdempotencyKey,
  aadhaarVerificationRewardNotifyKey,
} from './aadhaar-verification-reward.constants';

export interface AadhaarRewardResult {
  /** True when a new ledger credit was posted (false on idempotent replay). */
  credited: boolean;
  amount: string;
}

/**
 * Credits exactly 50 PROMOTIONAL (non-withdrawable) Coins once per user
 * after Aadhaar identity verification succeeds.
 */
@Injectable()
export class AadhaarVerificationRewardService {
  private readonly logger = new Logger(AadhaarVerificationRewardService.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly notificationsService: NotificationsService,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @InjectRepository(WalletTransaction)
    private readonly walletTransactionRepository: Repository<WalletTransaction>,
  ) {}

  /**
   * Credit inside an existing transaction (Aadhaar completion TX).
   * Safe to call on every VERIFIED path — ledger idempotency key is per userId.
   */
  async creditInTransaction(
    manager: EntityManager,
    params: {
      userId: string;
      identityVerificationId: string;
    },
  ): Promise<AadhaarRewardResult> {
    const wallet = await manager.getRepository(Wallet).findOne({
      where: { userId: params.userId },
    });
    if (!wallet) {
      throw new WalletNotFoundError();
    }

    const idempotencyKey = aadhaarVerificationRewardIdempotencyKey(
      params.userId,
    );
    const txnRepo = manager.getRepository(WalletTransaction);
    const existingBefore = await txnRepo.findOne({
      where: { idempotencyKey },
    });

    const result = await this.walletService.creditPointsInTransaction(manager, {
      walletId: wallet.id,
      userId: params.userId,
      amount: AADHAAR_VERIFICATION_REWARD_COINS,
      sourceType: WalletPointSource.PROMOTIONAL,
      referenceType: AADHAAR_VERIFICATION_REFERENCE_TYPE,
      referenceId: params.identityVerificationId,
      idempotencyKey,
      suppressWalletCreditNotification: true,
    });

    const credited = !existingBefore;

    await this.notificationsService.safeEnqueueInTransaction(manager, {
      recipientUserId: params.userId,
      type: NotificationType.AADHAAR_VERIFICATION_REWARD,
      title: 'BhaiWay Reward',
      body: '50 BhaiWay Coins have been added to your wallet for completing Aadhaar verification.',
      data: {
        type: NotificationType.AADHAAR_VERIFICATION_REWARD,
        amount: AADHAAR_VERIFICATION_REWARD_COINS.toString(),
        identityVerificationId: params.identityVerificationId,
        walletTransactionId: result.transaction.id,
      },
      idempotencyKey: aadhaarVerificationRewardNotifyKey(params.userId),
    });

    if (credited) {
      this.logger.log(
        `Aadhaar verification reward credited user=${params.userId} amount=50`,
      );
    }

    return {
      credited,
      amount: AADHAAR_VERIFICATION_REWARD_COINS.toString(),
    };
  }

  /**
   * Standalone idempotent credit (recovery when identity is already VERIFIED).
   */
  async creditForUser(params: {
    userId: string;
    identityVerificationId: string;
  }): Promise<AadhaarRewardResult> {
    const wallet = await this.walletRepository.findOne({
      where: { userId: params.userId },
    });
    if (!wallet) {
      throw new WalletNotFoundError();
    }

    const idempotencyKey = aadhaarVerificationRewardIdempotencyKey(
      params.userId,
    );
    const existingBefore = await this.walletTransactionRepository.findOne({
      where: { idempotencyKey },
    });

    const result = await this.walletService.creditPoints({
      walletId: wallet.id,
      userId: params.userId,
      amount: AADHAAR_VERIFICATION_REWARD_COINS,
      sourceType: WalletPointSource.PROMOTIONAL,
      referenceType: AADHAAR_VERIFICATION_REFERENCE_TYPE,
      referenceId: params.identityVerificationId,
      idempotencyKey,
      suppressWalletCreditNotification: true,
    });

    await this.notificationsService.safeEnqueue({
      recipientUserId: params.userId,
      type: NotificationType.AADHAAR_VERIFICATION_REWARD,
      title: 'BhaiWay Reward',
      body: '50 BhaiWay Coins have been added to your wallet for completing Aadhaar verification.',
      data: {
        type: NotificationType.AADHAAR_VERIFICATION_REWARD,
        amount: AADHAAR_VERIFICATION_REWARD_COINS.toString(),
        identityVerificationId: params.identityVerificationId,
        walletTransactionId: result.transaction.id,
      },
      idempotencyKey: aadhaarVerificationRewardNotifyKey(params.userId),
    });

    return {
      credited: !existingBefore,
      amount: AADHAAR_VERIFICATION_REWARD_COINS.toString(),
    };
  }
}
