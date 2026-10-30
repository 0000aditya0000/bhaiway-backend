import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssuredModule } from '../../assured/assured.module';
import { AssuredLifecycleEvent } from '../../assured/entities/assured-lifecycle-event.entity';
import { AuthModule } from '../../auth/auth.module';
import { Booking } from '../../bookings/entities/booking.entity';
import { ChatModule } from '../../chat/chat.module';
import { CorporateIdentityVerification } from '../../corporate-identity/entities/corporate-identity-verification.entity';
import { GstInvoice } from '../../invoices/entities/invoice.entity';
import { NotificationsModule } from '../../notifications/notifications.module';
import { RatingsModule } from '../../ratings/ratings.module';
import { RideSeries } from '../../rides/entities/ride-series.entity';
import { Ride } from '../../rides/entities/ride.entity';
import { TrackingModule } from '../../tracking/tracking.module';
import { UserProfile } from '../../users/entities/user-profile.entity';
import { User } from '../../users/entities/user.entity';
import { Vehicle } from '../../vehicles/entities/vehicle.entity';
import { UserVerification } from '../../verification/entities/user-verification.entity';
import { WalletHold } from '../../wallet/entities/wallet-hold.entity';
import { WalletTransaction } from '../../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../../wallet/entities/wallet.entity';
import { WalletModule } from '../../wallet/wallet.module';
import { AdminActivityEvent } from '../entities/admin-activity-event.entity';
import { AdminRideCancellation } from '../entities/admin-ride-cancellation.entity';
import { AdminUser } from '../entities/admin-user.entity';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { AdminRideCancellationService } from './admin-ride-cancellation.service';
import { AdminRidesController } from './admin-rides.controller';
import { AdminRidesService } from './admin-rides.service';

@Module({
  imports: [
    AuthModule,
    TrackingModule,
    WalletModule,
    RatingsModule,
    ChatModule,
    NotificationsModule,
    AssuredModule,
    TypeOrmModule.forFeature([
      AdminUser,
      AdminRideCancellation,
      AdminActivityEvent,
      Ride,
      RideSeries,
      Booking,
      User,
      UserProfile,
      UserVerification,
      CorporateIdentityVerification,
      Vehicle,
      Wallet,
      WalletHold,
      WalletTransaction,
      GstInvoice,
      AssuredLifecycleEvent,
    ]),
  ],
  controllers: [AdminRidesController],
  providers: [
    AdminRidesService,
    AdminRideCancellationService,
    AdminPermissionGuard,
  ],
  exports: [AdminRidesService, AdminRideCancellationService],
})
export class AdminRidesModule {}
