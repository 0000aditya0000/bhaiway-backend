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

@Entity('sos_triggers')
@Index('IDX_sos_triggers_sos_id', ['sosId'])
@Index('IDX_sos_triggers_user_id', ['userId'])
@Index('UQ_sos_triggers_idempotency_key', ['idempotencyKey'], {
  unique: true,
  where: '"idempotency_key" IS NOT NULL',
})
export class SosTrigger {
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

  @Column({ name: 'is_original', type: 'boolean', default: false })
  isOriginal!: boolean;

  @Column({ name: 'triggered_at', type: 'timestamptz' })
  triggeredAt!: Date;

  @Column({
    name: 'trigger_source',
    type: 'varchar',
    length: 50,
    default: 'APP',
  })
  triggerSource!: string;

  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  idempotencyKey!: string | null;

  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  accuracy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
