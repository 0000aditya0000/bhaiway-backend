import { randomUUID } from 'crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity('commute_reward_audit_logs')
@Index('IDX_commute_reward_audit_logs_campaign', ['campaignId'])
@Index('IDX_commute_reward_audit_logs_created', ['createdAt'])
export class CommuteRewardAuditLog {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'campaign_id', type: 'uuid', nullable: true })
  campaignId!: string | null;

  @Column({ name: 'claim_id', type: 'uuid', nullable: true })
  claimId!: string | null;

  @Column({ name: 'admin_id', type: 'uuid', nullable: true })
  adminId!: string | null;

  @Column({ name: 'driver_id', type: 'uuid', nullable: true })
  driverId!: string | null;

  @Column({ type: 'varchar', length: 80 })
  action!: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
