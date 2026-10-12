import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { Booking } from '../bookings/entities/booking.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Ride } from '../rides/entities/ride.entity';
import { PaymentOrder } from './entities/payment-order.entity';
import { PaymentWebhookEvent } from './entities/payment-webhook-event.entity';
import { WalletBalance } from './entities/wallet-balance.entity';
import { WalletHoldAllocation } from './entities/wallet-hold-allocation.entity';
import { WalletHold } from './entities/wallet-hold.entity';
import { WalletPointLot } from './entities/wallet-point-lot.entity';
import { UserPaymentMethod } from './entities/user-payment-method.entity';
import { WalletTransaction } from './entities/wallet-transaction.entity';
import { Wallet } from './entities/wallet.entity';
import { WithdrawalStatusHistory } from './entities/withdrawal-status-history.entity';
import { Withdrawal } from './entities/withdrawal.entity';
import { PaymentMethodService } from './payment-method.service';
import { WalletPaymentMethodsController } from './wallet-payment-methods.controller';
import { WalletWithdrawalsController } from './wallet-withdrawals.controller';
import { WithdrawalService } from './withdrawal.service';
import { PaymentGatewayModule } from './payment/payment-gateway.module';
import { PaymentWebhookController } from './payment/payment-webhook.controller';
import { TopUpService } from './top-up.service';
import { WalletController } from './wallet.controller';
import { WalletHistoryService } from './wallet-history.service';
import { WalletLotExpiryService } from './wallet-lot-expiry.service';
import { WalletQueryService } from './wallet-query.service';
import { WalletReconciliationService } from './wallet-reconciliation.service';
import { WalletService } from './wallet.service';

@Module({
  imports: [
    // forwardRef: AuthModule → ReferralsModule → WalletModule → AuthModule
    forwardRef(() => AuthModule),
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
      PaymentWebhookEvent,
      Booking,
      Ride,
      UserPaymentMethod,
      Withdrawal,
      WithdrawalStatusHistory,
    ]),
  ],
  controllers: [
    WalletController,
    WalletPaymentMethodsController,
    WalletWithdrawalsController,
    PaymentWebhookController,
  ],
  providers: [
    WalletService,
    PaymentMethodService,
    WithdrawalService,
    WalletQueryService,
    WalletHistoryService,
    TopUpService,
    WalletReconciliationService,
    WalletLotExpiryService,
  ],
  exports: [
    TypeOrmModule,
    WalletService,
    PaymentMethodService,
    WithdrawalService,
    WalletQueryService,
    WalletReconciliationService,
    WalletLotExpiryService,
  ],
})
export class WalletModule {}

