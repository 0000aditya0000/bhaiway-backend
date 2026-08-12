import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { randomUUID } from 'crypto';

export enum AssuredLifecycleEventType {
  DRIVER_CANCEL = 'DRIVER_CANCEL',
  RIDER_CANCEL = 'RIDER_CANCEL',
  DRIVER_NO_SHOW = 'DRIVER_NO_SHOW',
  RIDER_NO_SHOW = 'RIDER_NO_SHOW',
  PARTIAL_FILL_COMPENSATION = 'PARTIAL_FILL_COMPENSATION',
  HALF_TIME_DECISION = 'HALF_TIME_DECISION',
}

@Entity('assured_lifecycle_events')
@Index('IDX_assured_lifecycle_events_ride_id', ['rideId'])
@Index('IDX_assured_lifecycle_events_booking_id', ['bookingId'])
@Index('UQ_assured_lifecycle_events_idempotency_key', ['idempotencyKey'], {
  unique: true,
})
export class AssuredLifecycleEvent {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({
    name: 'event_type',
    type: 'enum',
    enum: AssuredLifecycleEventType,
  })
  eventType!: AssuredLifecycleEventType;

  @Column({ name: 'ride_id', type: 'uuid', nullable: true })
  rideId!: string | null;

  @Column({ name: 'booking_id', type: 'uuid', nullable: true })
  bookingId!: string | null;

  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId!: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @Column({ type: 'bigint', nullable: true })
  amount!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
