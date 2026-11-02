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
import { randomUUID } from 'crypto';
import { User } from '../../entities/user.entity';
import {
  AccountDeletionRequestStatus,
  DeletionReason,
} from '../enums/account-deletion.enums';

@Entity('account_deletion_requests')
@Index('IDX_account_deletion_requests_user_id', ['userId'])
@Index('IDX_account_deletion_requests_status', ['status'])
@Index('IDX_account_deletion_requests_created_at', ['createdAt'])
export class AccountDeletionRequest {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: DeletionReason,
  })
  reason!: DeletionReason;

  @Column({
    name: 'additional_comment',
    type: 'text',
    nullable: true,
  })
  additionalComment!: string | null;

  @Column({
    type: 'enum',
    enum: AccountDeletionRequestStatus,
    default: AccountDeletionRequestStatus.PENDING,
  })
  status!: AccountDeletionRequestStatus;

  @Column({
    name: 'requested_at',
    type: 'timestamptz',
  })
  requestedAt!: Date;

  @Column({
    name: 'reviewed_at',
    type: 'timestamptz',
    nullable: true,
  })
  reviewedAt!: Date | null;

  @Column({
    name: 'response_due_at',
    type: 'timestamptz',
  })
  responseDueAt!: Date;

  @Column({
    name: 'admin_id',
    type: 'uuid',
    nullable: true,
  })
  adminId!: string | null;

  @Column({
    name: 'admin_note',
    type: 'text',
    nullable: true,
  })
  adminNote!: string | null;

  @Column({
    name: 'user_action_required',
    type: 'boolean',
    default: false,
  })
  userActionRequired!: boolean;

  @Column({
    name: 'user_action_message',
    type: 'text',
    nullable: true,
  })
  userActionMessage!: string | null;

  @Column({
    name: 'approved_at',
    type: 'timestamptz',
    nullable: true,
  })
  approvedAt!: Date | null;

  @Column({
    name: 'completed_at',
    type: 'timestamptz',
    nullable: true,
  })
  completedAt!: Date | null;

  @Column({
    name: 'cancelled_at',
    type: 'timestamptz',
    nullable: true,
  })
  cancelledAt!: Date | null;

  @Column({
    name: 'cancellation_reason',
    type: 'text',
    nullable: true,
  })
  cancellationReason!: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
  })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
