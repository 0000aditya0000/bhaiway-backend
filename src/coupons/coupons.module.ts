import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { AdminModule } from '../admin/admin.module';
import { SettingsModule } from '../settings/settings.module';
import { User } from '../users/entities/user.entity';
import { VerificationModule } from '../verification/verification.module';
import { WalletModule } from '../wallet/wallet.module';
import { AdminCouponsController } from './admin-coupons.controller';
import { CouponIssuanceService } from './coupon-issuance.service';
import { CouponRedemptionService } from './coupon-redemption.service';
import { CouponsController } from './coupons.controller';
import { CouponsService } from './coupons.service';
import { CouponAssignment } from './entities/coupon-assignment.entity';
import { CouponAuditLog } from './entities/coupon-audit-log.entity';
import { CouponIssuanceRule } from './entities/coupon-issuance-rule.entity';
import { CouponIssuance } from './entities/coupon-issuance.entity';
import { CouponRedemption } from './entities/coupon-redemption.entity';
import { Coupon } from './entities/coupon.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Coupon,
      CouponAssignment,
      CouponRedemption,
      CouponIssuance,
      CouponIssuanceRule,
      CouponAuditLog,
      User,
    ]),
    forwardRef(() => AuthModule),
    forwardRef(() => AdminModule),
    forwardRef(() => WalletModule),
    SettingsModule,
    forwardRef(() => VerificationModule),
  ],
  controllers: [CouponsController, AdminCouponsController],
  providers: [CouponsService, CouponRedemptionService, CouponIssuanceService],
  exports: [
    CouponsService,
    CouponRedemptionService,
    CouponIssuanceService,
    TypeOrmModule,
  ],
})
export class CouponsModule {}
