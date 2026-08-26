import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module';
import { FareSettlementService } from './fare-settlement.service';

@Module({
  imports: [WalletModule],
  providers: [FareSettlementService],
  exports: [FareSettlementService],
})
export class FareModule {}
