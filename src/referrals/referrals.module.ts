import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UserProfile } from '../users/entities/user-profile.entity';
import { User } from '../users/entities/user.entity';
import { WalletModule } from '../wallet/wallet.module';
import { Referral } from './entities/referral.entity';
import { ReferralService } from './referral.service';
import { ReferralsController } from './referrals.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Referral, User, UserProfile]),
    forwardRef(() => AuthModule),
    forwardRef(() => WalletModule),
    forwardRef(() => NotificationsModule),
  ],
  controllers: [ReferralsController],
  providers: [ReferralService],
  exports: [ReferralService],
})
export class ReferralsModule {}
