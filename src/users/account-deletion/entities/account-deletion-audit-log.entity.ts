import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { randomUUID } from 'crypto';
import {
  AccountDeletionActorType,
  AccountDeletionAuditAction,
} from '../enums/account-deletion.enums';

@Entity('account_deletion_audit_logs')
@Index('IDX_account_deletion_audit_logs_request_id', ['requestId'])
@Index('IDX_account_deletion_audit_logs_user_id', ['userId'])
@Index('IDX_account_deletion_audit_logs_created_at', ['createdAt'])
export class AccountDeletionAuditLog {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'request_id', type: 'uuid' })
  requestId!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({
    name: 'actor_type',
    type: 'enum',
    enum: AccountDeletionActorType,
  })
  actorType!: AccountDeletionActorType;

  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId!: string | null;

  @Column({
    type: 'enum',
    enum: AccountDeletionAuditAction,
  })
  action!: AccountDeletionAuditAction;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
