import { randomUUID } from 'crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { CommuteRewardCampaignStatus } from '../enums/commute-reward.enums';
import { CommuteRewardMilestone } from './commute-reward-milestone.entity';

@Entity('commute_reward_campaigns')
@Index('IDX_commute_reward_campaigns_status', ['status'])
export class CommuteRewardCampaign {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 160 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Client-uploaded object URL (no server upload pipeline). */
  @Column({ name: 'banner_url', type: 'varchar', length: 1024, nullable: true })
  bannerUrl!: string | null;

  @Column({ type: 'varchar', length: 32 })
  status!: CommuteRewardCampaignStatus;

  /** IANA timezone used for calendar-month milestone windows. */
  @Column({ type: 'varchar', length: 64, default: 'Asia/Kolkata' })
  timezone!: string;

  @Column({ name: 'starts_at', type: 'timestamptz' })
  startsAt!: Date;

  @Column({ name: 'ends_at', type: 'timestamptz' })
  endsAt!: Date;

  /**
   * Frozen when campaign is first activated. Increments only if a future
   * versioning path is added; ACTIVE campaigns cannot edit milestones.
   */
  @Column({ name: 'config_version', type: 'int', default: 1 })
  configVersion!: number;

  @Column({ name: 'created_by_admin_id', type: 'uuid', nullable: true })
  createdByAdminId!: string | null;

  @OneToMany(() => CommuteRewardMilestone, (m) => m.campaign)
  milestones!: CommuteRewardMilestone[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
