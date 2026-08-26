import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { WalletBalance } from './entities/wallet-balance.entity';
import { WalletPointLot } from './entities/wallet-point-lot.entity';
import {
  reconcileBalanceWithLots,
  WalletReconciliationResult,
} from './wallet-lot-balance.math';

/**
 * Read-only reconciliation between materialized wallet_balances and wallet_point_lots.
 * Not exposed via public HTTP APIs.
 */
@Injectable()
export class WalletReconciliationService {
  constructor(
    @InjectRepository(WalletBalance)
    private readonly walletBalanceRepository: Repository<WalletBalance>,
    @InjectRepository(WalletPointLot)
    private readonly walletPointLotRepository: Repository<WalletPointLot>,
  ) {}

  async reconcileWallet(
    walletId: string,
    now: Date = new Date(),
  ): Promise<WalletReconciliationResult> {
    const balance = await this.walletBalanceRepository.findOne({
      where: { walletId },
    });
    if (!balance) {
      return {
        ok: true,
        drift: [],
      };
    }

    const lots = await this.walletPointLotRepository.find({
      where: { walletId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    return reconcileBalanceWithLots(balance, lots, now);
  }
}
