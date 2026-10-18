import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { Booking } from '../bookings/entities/booking.entity';
import { CorporateIdentityVerification } from '../corporate-identity/entities/corporate-identity-verification.entity';
import { RatingsModule } from '../ratings/ratings.module';
import { Ride } from '../rides/entities/ride.entity';
import { TrackingModule } from '../tracking/tracking.module';
import { UserDriverEarningsService } from '../users/user-driver-earnings.service';
import { UserProfile } from '../users/entities/user-profile.entity';
import { User } from '../users/entities/user.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { UserVerification } from '../verification/entities/user-verification.entity';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import { AdminAlertService } from './admin-alert.service';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminDriversController } from './admin-drivers.controller';
import { AdminDriversService } from './admin-drivers.service';
import { AdminTransactionsController } from './admin-transactions.controller';
import { AdminTransactionsService } from './admin-transactions.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminWithdrawalsController } from './admin-withdrawals.controller';
import { AdminActivityEvent } from './entities/admin-activity-event.entity';
import { AdminAlert } from './entities/admin-alert.entity';
import { AdminUser } from './entities/admin-user.entity';
import { AdminPermissionGuard } from './guards/admin-permission.guard';

@Module({
  imports: [
    AuthModule,
    TrackingModule,
    WalletModule,
    RatingsModule,
    TypeOrmModule.forFeature([
      AdminUser,
      AdminAlert,
      AdminActivityEvent,
      Ride,
      Booking,
      User,
      UserProfile,
      UserVerification,
      CorporateIdentityVerification,
      Vehicle,
      Wallet,
      WalletTransaction,
    ]),
  ],
  controllers: [
    AdminAuthController,
    AdminDashboardController,
    AdminWithdrawalsController,
    AdminTransactionsController,
    AdminUsersController,
    AdminDriversController,
  ],
  providers: [
    AdminAuthService,
    AdminDashboardService,
    AdminAlertService,
    AdminTransactionsService,
    AdminUsersService,
    AdminDriversService,
    UserDriverEarningsService,
    AdminPermissionGuard,
  ],
  exports: [
    AdminAuthService,
    AdminAlertService,
    AdminPermissionGuard,
    TypeOrmModule,
  ],
})
export class AdminModule {}
