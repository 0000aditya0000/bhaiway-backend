import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { UserCoupon } from '../coupons/entities/user-coupon.entity';
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
    ]),
    WalletModule,
    SettingsModule,
  ],
  providers: [
    AssuredLifecycleService,
    AssuredQueueService,
    AssuredGeographicQueueService,
  ],
  exports: [
    AssuredLifecycleService,
    AssuredQueueService,
    AssuredGeographicQueueService,
  ],
})
export class AssuredModule {}
