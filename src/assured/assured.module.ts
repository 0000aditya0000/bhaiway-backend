import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { UserCoupon } from '../coupons/entities/user-coupon.entity';
import { Ride } from '../rides/entities/ride.entity';
import { WalletHold } from '../wallet/entities/wallet-hold.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import { AssuredLifecycleService } from './assured-lifecycle.service';
import { AssuredLifecycleEvent } from './entities/assured-lifecycle-event.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Ride,
      Booking,
      Wallet,
      WalletHold,
      AssuredLifecycleEvent,
      UserCoupon,
    ]),
    WalletModule,
  ],
  providers: [AssuredLifecycleService],
  exports: [AssuredLifecycleService],
})
export class AssuredModule {}
