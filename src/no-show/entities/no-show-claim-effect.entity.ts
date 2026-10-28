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
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { NoShowClaim } from './no-show-claim.entity';
import {
  NoShowClaimEffectKind,
  NoShowClaimEffectStatus,
} from '../enums/no-show.enums';

export type NoShowClaimEffectPayload = {
  resolution?: 'approved' | 'rejected' | 'timeout';
};

@Entity('no_show_claim_effects')
@Unique('UQ_no_show_claim_effects_claim_kind', ['claimId', 'kind'])
@Index('IDX_no_show_claim_effects_claim_id', ['claimId'])
@Index('IDX_no_show_claim_effects_status_next_attempt', [
  'status',
  'nextAttemptAt',
])
export class NoShowClaimEffect {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => NoShowClaim, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'claim_id' })
  claim!: NoShowClaim;

  @Column({ name: 'claim_id', type: 'uuid' })
  claimId!: string;

  @Column({
    type: 'enum',
    enum: NoShowClaimEffectKind,
  })
  kind!: NoShowClaimEffectKind;

  @Column({
    type: 'enum',
    enum: NoShowClaimEffectStatus,
    default: NoShowClaimEffectStatus.PENDING,
  })
  status!: NoShowClaimEffectStatus;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  payload!: NoShowClaimEffectPayload;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
