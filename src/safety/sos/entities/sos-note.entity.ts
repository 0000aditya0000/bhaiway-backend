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

import { SosEvent } from './sos-event.entity';

@Entity('sos_notes')
@Index('IDX_sos_notes_sos_id', ['sosId'])
export class SosNote {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => SosEvent, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sos_id' })
  sos!: SosEvent;

  @Column({ name: 'sos_id', type: 'uuid' })
  sosId!: string;

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
