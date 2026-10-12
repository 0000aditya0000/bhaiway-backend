import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { AdminModule } from '../admin/admin.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UserProfile } from '../users/entities/user-profile.entity';
import { User } from '../users/entities/user.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { WalletModule } from '../wallet/wallet.module';
import { AadhaarVerificationRewardService } from './aadhaar-verification-reward.service';
import { CashfreeWebhookEvent } from './entities/cashfree-webhook-event.entity';
import { UserIdentityVerification } from './entities/user-identity-verification.entity';
import { UserVerification } from './entities/user-verification.entity';
import { VehicleRcVerification } from './entities/vehicle-rc-verification.entity';
import { CashfreeConfigService } from './cashfree/cashfree.config';
import { CashfreeDigiLockerService } from './cashfree/cashfree-digilocker.service';
import { CashfreeVehicleRcService } from './cashfree/cashfree-vehicle-rc.service';
import { CashfreeKycService } from './cashfree/cashfree-kyc.service';
import { CashfreeKycController } from './cashfree/cashfree-kyc.controller';
import { CashfreeKycCallbackController } from './cashfree/cashfree-kyc-callback.controller';
import { CashfreeKycWebhookController } from './cashfree/cashfree-kyc-webhook.controller';
import { StubVerificationProvider } from './providers/stub-verification.provider';
import { VERIFICATION_PROVIDER } from './providers/verification-provider.interface';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      UserProfile,
      UserVerification,
      UserIdentityVerification,
      CashfreeWebhookEvent,
      Vehicle,
      VehicleRcVerification,
    ]),
    AuthModule,
    AdminModule,
    WalletModule,
    NotificationsModule,
  ],
  controllers: [
    VerificationController,
    CashfreeKycController,
    CashfreeKycCallbackController,
    CashfreeKycWebhookController,
  ],
  providers: [
    VerificationService,
    CashfreeConfigService,
    CashfreeDigiLockerService,
    CashfreeVehicleRcService,
    CashfreeKycService,
    AadhaarVerificationRewardService,
    StubVerificationProvider,
    {
      provide: VERIFICATION_PROVIDER,
      useExisting: StubVerificationProvider,
    },
  ],
  exports: [
    TypeOrmModule,
    VerificationService,
    CashfreeDigiLockerService,
    CashfreeVehicleRcService,
    CashfreeKycService,
    AadhaarVerificationRewardService,
  ],
})
export class VerificationModule {}
