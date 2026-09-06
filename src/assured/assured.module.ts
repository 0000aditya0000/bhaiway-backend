import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { ChatModule } from '../chat/chat.module';
import { UserCoupon } from '../coupons/entities/user-coupon.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Ride } from '../rides/entities/ride.entity';
import { SettingsModule } from '../settings/settings.module';
import { WalletHold } from '../wallet/entities/wallet-hold.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import { AssuredGeographicQueueService } from './assured-geographic-queue.service';
import { AssuredLifecycleService } from './assured-lifecycle.service';
import { AssuredQueueService } from './assured-queue.service';
import { AssuredGeographicQueue } from './entities/assured-geographic-queue.entity';
import { AssuredLifecycleEvent } from './entities/assured-lifecycle-event.entity';
import { AssuredQueueEvent } from './entities/assured-queue-event.entity';
import { PassengerAssuredDepositPenalty } from './entities/passenger-assured-deposit-penalty.entity';
import { PassengerAssuredDepositPenaltyService } from './passenger-assured-deposit-penalty.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Ride,
      Booking,
      Wallet,
      WalletHold,
      AssuredLifecycleEvent,
      AssuredQueueEvent,
      AssuredGeographicQueue,
      UserCoupon,
      PassengerAssuredDepositPenalty,
    ]),
    WalletModule,
    SettingsModule,
    ChatModule,
    NotificationsModule,
  ],
  providers: [
    AssuredLifecycleService,
    AssuredQueueService,
    AssuredGeographicQueueService,
    PassengerAssuredDepositPenaltyService,
  ],
  exports: [
    AssuredLifecycleService,
    AssuredQueueService,
    AssuredGeographicQueueService,
    PassengerAssuredDepositPenaltyService,
  ],
})
export class AssuredModule {}
