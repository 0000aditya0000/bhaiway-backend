import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { Ride } from '../rides/entities/ride.entity';
import { TrackingModule } from '../tracking/tracking.module';
import { UserProfile } from '../users/entities/user-profile.entity';
import { User } from '../users/entities/user.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { UserVerification } from '../verification/entities/user-verification.entity';
import { WalletTransaction } from '../wallet/entities/wallet-transaction.entity';
import { AdminAlertService } from './admin-alert.service';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminActivityEvent } from './entities/admin-activity-event.entity';
import { AdminAlert } from './entities/admin-alert.entity';
import { AdminUser } from './entities/admin-user.entity';
import { AdminPermissionGuard } from './guards/admin-permission.guard';

@Module({
  imports: [
    AuthModule,
    TrackingModule,
    TypeOrmModule.forFeature([
      AdminUser,
      AdminAlert,
      AdminActivityEvent,
      Ride,
      User,
      UserProfile,
      UserVerification,
      Vehicle,
      WalletTransaction,
    ]),
  ],
  controllers: [AdminDashboardController],
  providers: [
    AdminDashboardService,
    AdminAlertService,
    AdminPermissionGuard,
  ],
  exports: [AdminAlertService, AdminPermissionGuard, TypeOrmModule],
})
export class AdminModule {}
