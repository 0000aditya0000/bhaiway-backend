import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { AssuredModule } from '../assured/assured.module';
import { Booking } from '../bookings/entities/booking.entity';
import { RatingsModule } from '../ratings/ratings.module';
import { Ride } from '../rides/entities/ride.entity';
import { RideSeries } from '../rides/entities/ride-series.entity';
import { WalletModule } from '../wallet/wallet.module';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import { UserProfile } from './entities/user-profile.entity';
import { User } from './entities/user.entity';
import { EmailVerificationModule } from '../email-verification/email-verification.module';
import { EmailVerificationOtp } from '../email-verification/entities/email-verification-otp.entity';
import { EmailChangeService } from './email-change.service';
import { UserDriverEarningsService } from './user-driver-earnings.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      UserProfile,
      WalletTransaction,
      Booking,
      Ride,
      RideSeries,
      EmailVerificationOtp,
    ]),
    AuthModule,
    AssuredModule,
    WalletModule,
    RatingsModule,
    EmailVerificationModule,
  ],
  controllers: [UsersController],
  providers: [UsersService, UserDriverEarningsService, EmailChangeService],
  exports: [TypeOrmModule, UsersService, EmailChangeService],
})
export class UsersModule {}
