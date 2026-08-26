import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { randomUUID } from 'crypto';

import {
  AssuredQueueAdvanceReason,
  AssuredQueueEventType,
} from '../enums/assured-queue.enums';

@Entity('assured_queue_events')
@Index('IDX_assured_queue_events_queue_key', ['queueKey'])
@Index('UQ_assured_queue_events_idempotency_key', ['idempotencyKey'], {
  unique: true,
})
export class AssuredQueueEvent {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'queue_key', type: 'varchar', length: 512 })
  queueKey!: string;

  @Column({
    name: 'event_type',
    type: 'enum',
    enum: AssuredQueueEventType,
  })
  eventType!: AssuredQueueEventType;

  @Column({
    name: 'advance_reason',
    type: 'enum',
    enum: AssuredQueueAdvanceReason,
    nullable: true,
  })
  advanceReason!: AssuredQueueAdvanceReason | null;

  @Column({ name: 'source_ride_id', type: 'uuid', nullable: true })
  sourceRideId!: string | null;

  @Column({ name: 'promoted_ride_id', type: 'uuid', nullable: true })
  promotedRideId!: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
