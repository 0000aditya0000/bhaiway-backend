import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module';
import { CommuteSettlementService } from './commute-settlement.service';
import { FareSettlementService } from './fare-settlement.service';

@Module({
  imports: [WalletModule],
  providers: [FareSettlementService, CommuteSettlementService],
  exports: [FareSettlementService, CommuteSettlementService],
})
export class FareModule {}
