import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssuredModule } from '../assured/assured.module';
import { FareModule } from '../fare/fare.module';
import { RatingsModule } from '../ratings/ratings.module';
import { AuthModule } from '../auth/auth.module';
import { Booking } from '../bookings/entities/booking.entity';
import { BookingsModule } from '../bookings/bookings.module';
import { ChatModule } from '../chat/chat.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { TrackingModule } from '../tracking/tracking.module';
import { User } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { UserVerification } from '../verification/entities/user-verification.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { VerificationModule } from '../verification/verification.module';
import { WalletHold } from '../wallet/entities/wallet-hold.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import { Ride } from './entities/ride.entity';
import { RidesController } from './rides.controller';
import { RidesService } from './rides.service';
import { RideDirectionsService } from './route/ride-directions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Ride,
      User,
      UserProfile,
      UserVerification,
      Vehicle,
      Wallet,
      Booking,
      WalletHold,
    ]),
    AuthModule,
    VerificationModule,
    WalletModule,
    SettingsModule,
    AssuredModule,
    FareModule,
    BookingsModule,
    RatingsModule,
    TrackingModule,
    ChatModule,
    NotificationsModule,
  ],
  controllers: [RidesController],
  providers: [RidesService, RideDirectionsService],
  exports: [TypeOrmModule, RidesService],
})
export class RidesModule {}
