import { randomUUID } from 'crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { CommuteRewardClaimStatus } from '../enums/commute-reward.enums';
import { CommuteRewardCampaign } from './commute-reward-campaign.entity';
import { CommuteRewardMilestone } from './commute-reward-milestone.entity';

@Entity('commute_reward_claims')
@Index(
  'UQ_commute_reward_claims_campaign_driver_milestone',
  ['campaignId', 'driverId', 'milestoneId'],
  { unique: true },
)
@Index('IDX_commute_reward_claims_status', ['status'])
@Index('IDX_commute_reward_claims_driver', ['driverId'])
export class CommuteRewardClaim {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => CommuteRewardCampaign, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaign_id' })
  campaign!: CommuteRewardCampaign;

  @Column({ name: 'campaign_id', type: 'uuid' })
  campaignId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'driver_id' })
  driver!: User;

  @Column({ name: 'driver_id', type: 'uuid' })
  driverId!: string;

  @ManyToOne(() => CommuteRewardMilestone, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'milestone_id' })
  milestone!: CommuteRewardMilestone;

  @Column({ name: 'milestone_id', type: 'uuid' })
  milestoneId!: string;

  @Column({ type: 'varchar', length: 32 })
  status!: CommuteRewardClaimStatus;

  @Column({ name: 'campaign_config_version', type: 'int' })
  campaignConfigVersion!: number;

  @Column({ name: 'qualifying_trip_count_snapshot', type: 'int' })
  qualifyingTripCountSnapshot!: number;

  @Column({ name: 'prize_value_cap_inr_snapshot', type: 'int' })
  prizeValueCapInrSnapshot!: number;

  @Column({ name: 'prize_description_snapshot', type: 'text', nullable: true })
  prizeDescriptionSnapshot!: string | null;

  @Column({ name: 'prize_snapshot', type: 'jsonb' })
  prizeSnapshot!: Record<string, unknown>;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason!: string | null;

  @Column({ name: 'reviewed_by_admin_id', type: 'uuid', nullable: true })
  reviewedByAdminId!: string | null;

  @Column({ name: 'claimed_at', type: 'timestamptz' })
  claimedAt!: Date;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  @Column({ name: 'fulfilled_at', type: 'timestamptz', nullable: true })
  fulfilledAt!: Date | null;

  @Column({ name: 'fulfilment_notes', type: 'text', nullable: true })
  fulfilmentNotes!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
