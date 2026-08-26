import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { WalletBalanceResponseDto } from './dto/wallet-balance-response.dto';
import { WalletBalance } from './entities/wallet-balance.entity';
import { Wallet } from './entities/wallet.entity';
import {
  WalletBalanceNotFoundError,
  WalletNotFoundError,
} from './errors/wallet.errors';
import { pointsToCoins, sumPoints } from './wallet-coins.mapper';

@Injectable()
export class WalletQueryService {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @InjectRepository(WalletBalance)
    private readonly walletBalanceRepository: Repository<WalletBalance>,
  ) {}

  async getBalanceForUser(userId: string): Promise<WalletBalanceResponseDto> {
    const wallet = await this.walletRepository.findOne({
      where: { userId },
    });
    if (!wallet) {
      throw new WalletNotFoundError();
    }

    const balance = await this.walletBalanceRepository.findOne({
      where: { walletId: wallet.id },
    });
    if (!balance) {
      throw new WalletBalanceNotFoundError(wallet.id);
    }

    return this.toBalanceResponse(balance);
  }

  private toBalanceResponse(balance: WalletBalance): WalletBalanceResponseDto {
    const purchasedAvailable = balance.purchasedAvailable;
    const purchasedHeld = balance.purchasedHeld;
    const promotionalAvailable = balance.promotionalAvailable;
    const promotionalHeld = balance.promotionalHeld;
    const driverEarnedAvailable = balance.driverEarnedAvailable;
    const driverEarnedHeld = balance.driverEarnedHeld;

    const availableCoins = sumPoints([
      promotionalAvailable,
      purchasedAvailable,
      driverEarnedAvailable,
    ]);
    const heldCoins = sumPoints([
      promotionalHeld,
      purchasedHeld,
      driverEarnedHeld,
    ]);
    const balanceCoins = sumPoints([availableCoins, heldCoins]);
    const withdrawableCoins = pointsToCoins(driverEarnedAvailable);
    const nonWithdrawableCoins = sumPoints([
      promotionalAvailable,
      purchasedAvailable,
    ]);

    return {
      balanceCoins,
      availableCoins,
      heldCoins,
      withdrawableCoins,
      nonWithdrawableCoins,
      buckets: {
        purchased: {
          availableCoins: pointsToCoins(purchasedAvailable),
          heldCoins: pointsToCoins(purchasedHeld),
        },
        promotional: {
          availableCoins: pointsToCoins(promotionalAvailable),
          heldCoins: pointsToCoins(promotionalHeld),
        },
        driverEarned: {
          availableCoins: pointsToCoins(driverEarnedAvailable),
          heldCoins: pointsToCoins(driverEarnedHeld),
        },
      },
    };
  }
}
