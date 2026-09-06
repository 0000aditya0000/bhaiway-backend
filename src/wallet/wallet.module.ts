import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { Booking } from '../bookings/entities/booking.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Ride } from '../rides/entities/ride.entity';
import { PaymentOrder } from './entities/payment-order.entity';
import { WalletBalance } from './entities/wallet-balance.entity';
import { WalletHoldAllocation } from './entities/wallet-hold-allocation.entity';
import { WalletHold } from './entities/wallet-hold.entity';
import { WalletPointLot } from './entities/wallet-point-lot.entity';
import { WalletTransaction } from './entities/wallet-transaction.entity';
import { Wallet } from './entities/wallet.entity';
import { PaymentGatewayModule } from './payment/payment-gateway.module';
import { TopUpService } from './top-up.service';
import { WalletController } from './wallet.controller';
import { WalletHistoryService } from './wallet-history.service';
import { WalletLotExpiryService } from './wallet-lot-expiry.service';
import { WalletQueryService } from './wallet-query.service';
import { WalletReconciliationService } from './wallet-reconciliation.service';
import { WalletService } from './wallet.service';

@Module({
  imports: [
    AuthModule,
    PaymentGatewayModule,
    NotificationsModule,
    TypeOrmModule.forFeature([
      Wallet,
      WalletBalance,
      WalletPointLot,
      WalletHold,
      WalletHoldAllocation,
      WalletTransaction,
      PaymentOrder,
      Booking,
      Ride,
    ]),
  ],
  controllers: [WalletController],
  providers: [
    WalletService,
    WalletQueryService,
    WalletHistoryService,
    TopUpService,
    WalletReconciliationService,
    WalletLotExpiryService,
  ],
  exports: [
    TypeOrmModule,
    WalletService,
    WalletQueryService,
    WalletReconciliationService,
    WalletLotExpiryService,
  ],
})
export class WalletModule {}

