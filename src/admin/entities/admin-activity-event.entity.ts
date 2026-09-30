import { randomUUID } from 'crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

import { AdminAlertCategory, AdminAlertSeverity } from './admin-alert.entity';

@Entity('admin_activity_events')
@Index('IDX_admin_activity_events_created_at', ['createdAt'])
export class AdminActivityEvent {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 80 })
  eventType!: string;

  @Column({ type: 'varchar', length: 50 })
  category!: AdminAlertCategory | string;

  @Column({
    type: 'enum',
    enum: AdminAlertSeverity,
    default: AdminAlertSeverity.INFO,
  })
  severity!: AdminAlertSeverity;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

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
