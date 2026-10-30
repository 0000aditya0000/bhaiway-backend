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

import { User } from '../../../users/entities/user.entity';
import { SosParticipantRole } from '../enums/sos.enums';
import { SosEvent } from './sos-event.entity';

@Entity('sos_participants')
@Index('UQ_sos_participants_sos_user', ['sosId', 'userId'], { unique: true })
export class SosParticipant {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => SosEvent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sos_id' })
  sos!: SosEvent;

  @Column({ name: 'sos_id', type: 'uuid' })
  sosId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: SosParticipantRole,
    enumName: 'sos_participant_role_enum',
  })
  role!: SosParticipantRole;

  @Column({
    name: 'display_name',
    type: 'varchar',
    length: 150,
    nullable: true,
  })
  displayName!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone!: string | null;

  @Column({ name: 'profile_photo', type: 'text', nullable: true })
  profilePhoto!: string | null;

  @Column({ name: 'booking_id', type: 'uuid', nullable: true })
  bookingId!: string | null;

  @Column({
    name: 'booking_status',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  bookingStatus!: string | null;

  @Column({
    name: 'pickup_status',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  pickupStatus!: string | null;

  @Column({ name: 'vehicle_id', type: 'uuid', nullable: true })
  vehicleId!: string | null;

  @Column({
    name: 'vehicle_make',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  vehicleMake!: string | null;

  @Column({
    name: 'vehicle_model',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  vehicleModel!: string | null;

  @Column({
    name: 'vehicle_registration_number',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  vehicleRegistrationNumber!: string | null;

  @Column({
    name: 'vehicle_color',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  vehicleColor!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
