import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssuredModule } from '../assured/assured.module';
import { FareModule } from '../fare/fare.module';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { CouponsModule } from '../coupons/coupons.module';
import { UserCoupon } from '../coupons/entities/user-coupon.entity';
import { NoShowModule } from '../no-show/no-show.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Ride } from '../rides/entities/ride.entity';
import { SettingsModule } from '../settings/settings.module';
import { User } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { UserVerification } from '../verification/entities/user-verification.entity';
import { VerificationModule } from '../verification/verification.module';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import { CommuteCancellationService } from './commute-cancellation.service';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { Booking } from './entities/booking.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Booking,
      Ride,
      User,
      UserProfile,
      UserVerification,
      Wallet,
      UserCoupon,
      Vehicle,
      WalletTransaction,
    ]),
    AuthModule,
    VerificationModule,
    WalletModule,
    SettingsModule,
    AssuredModule,
    FareModule,
    CouponsModule,
    ChatModule,
    NotificationsModule,
    forwardRef(() => NoShowModule),
  ],
  controllers: [BookingsController],
  providers: [BookingsService, CommuteCancellationService],
  exports: [TypeOrmModule, BookingsService, CommuteCancellationService],
})
export class BookingsModule {}
