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

import { SafetyIncident } from './safety-incident.entity';

@Entity('safety_incident_notes')
@Index('IDX_safety_incident_notes_incident_id', ['incidentId'])
export class SafetyIncidentNote {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => SafetyIncident, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'incident_id' })
  incident!: SafetyIncident;

  @Column({ name: 'incident_id', type: 'uuid' })
  incidentId!: string;

  @Column({ name: 'author_admin_user_id', type: 'uuid' })
  authorAdminUserId!: string;

  @Column({ name: 'author_user_id', type: 'uuid' })
  authorUserId!: string;

  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
