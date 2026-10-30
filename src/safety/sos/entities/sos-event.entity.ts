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
import { RideType } from '../../../rides/enums/ride.enums';
import { User } from '../../../users/entities/user.entity';
import { SosCategory, SosSeverity, SosStatus } from '../enums/sos.enums';

@Entity('sos_events')
@Index('IDX_sos_events_ride_id', ['rideId'])
@Index('IDX_sos_events_status', ['status'])
@Index('IDX_sos_events_triggered_at', ['triggeredAt'])
@Index('UQ_sos_events_one_active_per_ride', ['rideId'], {
  unique: true,
  where: `"status" IN ('TRIGGERED', 'ACKNOWLEDGED', 'RESPONDING')`,
})
export class SosEvent {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => Ride, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'ride_id' })
  ride!: Ride;

  @Column({ name: 'ride_id', type: 'uuid' })
  rideId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'original_trigger_user_id' })
  originalTriggerUser!: User;

  @Column({ name: 'original_trigger_user_id', type: 'uuid' })
  originalTriggerUserId!: string;

  @Column({
    type: 'enum',
    enum: SosCategory,
    enumName: 'sos_category_enum',
    default: SosCategory.EMERGENCY,
  })
  category!: SosCategory;

  @Column({
    type: 'enum',
    enum: SosSeverity,
    enumName: 'sos_severity_enum',
    default: SosSeverity.CRITICAL,
  })
  severity!: SosSeverity;

  @Column({
    type: 'enum',
    enum: SosStatus,
    enumName: 'sos_status_enum',
    default: SosStatus.TRIGGERED,
  })
  status!: SosStatus;

  @Column({
    name: 'ride_type',
    type: 'enum',
    enum: RideType,
    enumName: 'rides_ride_type_enum',
  })
  rideType!: RideType;

  @Column({ name: 'triggered_at', type: 'timestamptz' })
  triggeredAt!: Date;

  @Column({ name: 'acknowledged_at', type: 'timestamptz', nullable: true })
  acknowledgedAt!: Date | null;

  @Column({ name: 'acknowledged_by_admin_id', type: 'uuid', nullable: true })
  acknowledgedByAdminId!: string | null;

  @Column({ name: 'response_started_at', type: 'timestamptz', nullable: true })
  responseStartedAt!: Date | null;

  @Column({
    name: 'response_started_by_admin_id',
    type: 'uuid',
    nullable: true,
  })
  responseStartedByAdminId!: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ name: 'resolved_by_admin_id', type: 'uuid', nullable: true })
  resolvedByAdminId!: string | null;

  @Column({ name: 'resolution_reason', type: 'text', nullable: true })
  resolutionReason!: string | null;

  @Column({ name: 'false_alarm_at', type: 'timestamptz', nullable: true })
  falseAlarmAt!: Date | null;

  @Column({ name: 'false_alarm_by_admin_id', type: 'uuid', nullable: true })
  falseAlarmByAdminId!: string | null;

  @Column({
    name: 'trigger_latitude',
    type: 'double precision',
    nullable: true,
  })
  triggerLatitude!: number | null;

  @Column({
    name: 'trigger_longitude',
    type: 'double precision',
    nullable: true,
  })
  triggerLongitude!: number | null;

  @Column({
    name: 'trigger_accuracy',
    type: 'double precision',
    nullable: true,
  })
  triggerAccuracy!: number | null;

  @Column({
    name: 'trigger_location_at',
    type: 'timestamptz',
    nullable: true,
  })
  triggerLocationAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
