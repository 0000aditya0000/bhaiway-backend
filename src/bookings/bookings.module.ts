import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssuredModule } from '../assured/assured.module';
import { AuthModule } from '../auth/auth.module';
import { UserCoupon } from '../coupons/entities/user-coupon.entity';
import { Ride } from '../rides/entities/ride.entity';
import { SettingsModule } from '../settings/settings.module';
import { User } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { UserVerification } from '../verification/entities/user-verification.entity';
import { VerificationModule } from '../verification/verification.module';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
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
    ]),
    AuthModule,
    VerificationModule,
    WalletModule,
    SettingsModule,
    AssuredModule,
  ],
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [TypeOrmModule, BookingsService],
})
export class BookingsModule {}
