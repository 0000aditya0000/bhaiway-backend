import { randomUUID } from 'crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum AdminAlertSeverity {
  CRITICAL = 'CRITICAL',
  WARNING = 'WARNING',
  INFO = 'INFO',
}

export enum AdminAlertStatus {
  OPEN = 'OPEN',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  RESOLVED = 'RESOLVED',
}

export enum AdminAlertCategory {
  SYSTEM_HEALTH = 'SYSTEM_HEALTH',
  PAYMENT = 'PAYMENT',
  KYC = 'KYC',
  VEHICLE_VERIFICATION = 'VEHICLE_VERIFICATION',
  RIDE = 'RIDE',
  ASSURED_RIDE = 'ASSURED_RIDE',
  WALLET = 'WALLET',
  SECURITY = 'SECURITY',
  SOS = 'SOS',
}

@Entity('admin_alerts')
@Index('IDX_admin_alerts_status_severity', ['status', 'severity', 'createdAt'])
export class AdminAlert {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 50 })
  category!: AdminAlertCategory | string;

  @Column({
    type: 'enum',
    enum: AdminAlertSeverity,
  })
  severity!: AdminAlertSeverity;

  @Column({
    type: 'enum',
    enum: AdminAlertStatus,
    default: AdminAlertStatus.OPEN,
  })
  status!: AdminAlertStatus;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'varchar', length: 100 })
  source!: string;

  @Column({ name: 'incident_key', type: 'varchar', length: 255 })
  incidentKey!: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'acknowledged_at', type: 'timestamptz', nullable: true })
  acknowledgedAt!: Date | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ name: 'resolved_by_user_id', type: 'uuid', nullable: true })
  resolvedByUserId!: string | null;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
