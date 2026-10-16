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
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { CommuteRewardCampaign } from './commute-reward-campaign.entity';

/**
 * Auditable source of truth for qualifying Office Commute trips.
 * Progress counts are derived from this table — never trust client counts.
 */
@Entity('commute_reward_qualifying_trips')
@Index('UQ_commute_reward_qualifying_trips_campaign_ride', ['campaignId', 'rideId'], {
  unique: true,
})
@Index('IDX_commute_reward_qualifying_trips_driver', [
  'campaignId',
  'driverId',
  'completedAt',
])
export class CommuteRewardQualifyingTrip {
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

  @Column({ name: 'ride_id', type: 'uuid' })
  rideId!: string;

  /** Distinct passengers with COMPLETED + PICKED_UP at qualification time. */
  @Column({ name: 'completed_passenger_count', type: 'int' })
  completedPassengerCount!: number;

  @Column({ name: 'completed_at', type: 'timestamptz' })
  completedAt!: Date;

  @Column({ name: 'campaign_config_version', type: 'int' })
  campaignConfigVersion!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
