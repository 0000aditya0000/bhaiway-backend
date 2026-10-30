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

import { Ride } from '../../../rides/entities/ride.entity';
import {
  SafetyIncidentSeverity,
  SafetyIncidentStatus,
  SafetyIncidentType,
} from '../enums/sos.enums';
import { SosEvent } from './sos-event.entity';

@Entity('safety_incidents')
@Index('IDX_safety_incidents_status', ['status'])
@Index('IDX_safety_incidents_type', ['type'])
@Index('UQ_safety_incidents_sos_id', ['sosId'], {
  unique: true,
  where: '"sos_id" IS NOT NULL',
})
export class SafetyIncident {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => SosEvent, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'sos_id' })
  sos!: SosEvent | null;

  @Column({ name: 'sos_id', type: 'uuid', nullable: true })
  sosId!: string | null;

  @ManyToOne(() => Ride, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'ride_id' })
  ride!: Ride;

  @Column({ name: 'ride_id', type: 'uuid' })
  rideId!: string;

  @Column({
    type: 'enum',
    enum: SafetyIncidentType,
    enumName: 'safety_incident_type_enum',
  })
  type!: SafetyIncidentType;

  @Column({
    type: 'enum',
    enum: SafetyIncidentStatus,
    enumName: 'safety_incident_status_enum',
  })
  status!: SafetyIncidentStatus;

  @Column({
    type: 'enum',
    enum: SafetyIncidentSeverity,
    enumName: 'safety_incident_severity_enum',
  })
  severity!: SafetyIncidentSeverity;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  summary!: string | null;

  @Column({ name: 'assigned_admin_user_id', type: 'uuid', nullable: true })
  assignedAdminUserId!: string | null;

  @Column({ name: 'assigned_at', type: 'timestamptz', nullable: true })
  assignedAt!: Date | null;

  @Column({ name: 'escalated_at', type: 'timestamptz', nullable: true })
  escalatedAt!: Date | null;

  @Column({ name: 'escalated_by_admin_user_id', type: 'uuid', nullable: true })
  escalatedByAdminUserId!: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ name: 'resolved_by_admin_user_id', type: 'uuid', nullable: true })
  resolvedByAdminUserId!: string | null;

  @Column({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote!: string | null;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
