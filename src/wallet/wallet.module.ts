import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Wallet } from './entities/wallet.entity';
import { WalletBalance } from './entities/wallet-balance.entity';
import { WalletPointLot } from './entities/wallet-point-lot.entity';
import { WalletHold } from './entities/wallet-hold.entity';
import { WalletHoldAllocation } from './entities/wallet-hold-allocation.entity';
import { WalletTransaction } from './entities/wallet-transaction.entity';
import { WalletService } from './wallet.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Wallet,
      WalletBalance,
      WalletPointLot,
      WalletHold,
      WalletHoldAllocation,
      WalletTransaction,
    ]),
  ],
  providers: [WalletService],
  exports: [TypeOrmModule, WalletService],
})
export class WalletModule {}
