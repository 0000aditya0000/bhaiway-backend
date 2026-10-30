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

import { SosActorType, SosTimelineEventType } from '../enums/sos.enums';
import { SosEvent } from './sos-event.entity';

@Entity('sos_timeline_events')
@Index('IDX_sos_timeline_events_sos_id', ['sosId'])
@Index('IDX_sos_timeline_events_created_at', ['createdAt'])
export class SosTimelineEvent {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => SosEvent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sos_id' })
  sos!: SosEvent;

  @Column({ name: 'sos_id', type: 'uuid' })
  sosId!: string;

  @Column({
    name: 'event_type',
    type: 'enum',
    enum: SosTimelineEventType,
    enumName: 'sos_timeline_event_type_enum',
  })
  eventType!: SosTimelineEventType;

  @Column({
    name: 'actor_type',
    type: 'enum',
    enum: SosActorType,
    enumName: 'sos_actor_type_enum',
  })
  actorType!: SosActorType;

  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId!: string | null;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
