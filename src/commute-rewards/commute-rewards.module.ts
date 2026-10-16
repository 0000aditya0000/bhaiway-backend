import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { AdminCommuteRewardsController } from './admin-commute-rewards.controller';
import { CommuteRewardProgressService } from './commute-reward-progress.service';
import { CommuteRewardsController } from './commute-rewards.controller';
import { CommuteRewardsService } from './commute-rewards.service';
import { CommuteRewardAuditLog } from './entities/commute-reward-audit-log.entity';
import { CommuteRewardCampaign } from './entities/commute-reward-campaign.entity';
import { CommuteRewardClaim } from './entities/commute-reward-claim.entity';
import { CommuteRewardMilestone } from './entities/commute-reward-milestone.entity';
import { CommuteRewardQualifyingTrip } from './entities/commute-reward-qualifying-trip.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CommuteRewardCampaign,
      CommuteRewardMilestone,
      CommuteRewardQualifyingTrip,
      CommuteRewardClaim,
      CommuteRewardAuditLog,
    ]),
    forwardRef(() => AuthModule),
    forwardRef(() => AdminModule),
  ],
  controllers: [CommuteRewardsController, AdminCommuteRewardsController],
  providers: [CommuteRewardsService, CommuteRewardProgressService],
  exports: [CommuteRewardsService, CommuteRewardProgressService],
})
export class CommuteRewardsModule {}
