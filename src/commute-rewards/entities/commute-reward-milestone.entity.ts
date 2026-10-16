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

import { CommuteRewardWindowType } from '../enums/commute-reward.enums';
import { CommuteRewardCampaign } from './commute-reward-campaign.entity';

@Entity('commute_reward_milestones')
@Index('UQ_commute_reward_milestones_campaign_order', ['campaignId', 'sortOrder'], {
  unique: true,
})
export class CommuteRewardMilestone {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => CommuteRewardCampaign, (c) => c.milestones, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'campaign_id' })
  campaign!: CommuteRewardCampaign;

  @Column({ name: 'campaign_id', type: 'uuid' })
  campaignId!: string;

  /** 1-based sequential order (1 before 2 before 3). */
  @Column({ name: 'sort_order', type: 'int' })
  sortOrder!: number;

  @Column({ type: 'varchar', length: 120 })
  title!: string;

  @Column({ name: 'required_trips', type: 'int' })
  requiredTrips!: number;

  @Column({
    name: 'window_type',
    type: 'varchar',
    length: 48,
    default: CommuteRewardWindowType.CALENDAR_MONTHS_FROM_START,
  })
  windowType!: CommuteRewardWindowType;

  /** Calendar months from campaign start (inclusive start, exclusive end). */
  @Column({ name: 'window_months', type: 'int' })
  windowMonths!: number;

  /** Prize value cap in whole INR (not wallet points). */
  @Column({ name: 'prize_value_cap_inr', type: 'int' })
  prizeValueCapInr!: number;

  @Column({ name: 'prize_description', type: 'text', nullable: true })
  prizeDescription!: string | null;

  @Column({ name: 'prize_image_url', type: 'varchar', length: 1024, nullable: true })
  prizeImageUrl!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
