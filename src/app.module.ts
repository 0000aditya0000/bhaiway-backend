import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AssuredModule } from './assured/assured.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { BookingsModule } from './bookings/bookings.module';
import { ChatModule } from './chat/chat.module';
import { LoggingModule } from './common/logging/logging.module';
import { CouponsModule } from './coupons/coupons.module';
import { DatabaseModule } from './database/database.module';
import { CorporateIdentityModule } from './corporate-identity/corporate-identity.module';
import { EmailVerificationModule } from './email-verification/email-verification.module';
import { HealthModule } from './health/health.module';
import { NotificationsModule } from './notifications/notifications.module';
import { RatingsModule } from './ratings/ratings.module';
import { ReferralsModule } from './referrals/referrals.module';
import { RidesModule } from './rides/rides.module';
import { SafetyModule } from './safety/safety.module';
import { SettingsModule } from './settings/settings.module';
import { TrackingModule } from './tracking/tracking.module';
import { UsersModule } from './users/users.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { VerificationModule } from './verification/verification.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    LoggingModule,
    DatabaseModule,
    HealthModule,
    AuthModule,
    AdminModule,
    UsersModule,
    EmailVerificationModule,
    CorporateIdentityModule,
    ReferralsModule,
    CouponsModule,
    WalletModule,
    SettingsModule,
    VerificationModule,
    VehiclesModule,
    AssuredModule,
    RidesModule,
    BookingsModule,
    RatingsModule,
    TrackingModule,
    ChatModule,
    NotificationsModule,
    SafetyModule,
  ],
})
export class AppModule {}
