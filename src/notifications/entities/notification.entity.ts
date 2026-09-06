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

import { User } from '../../users/entities/user.entity';
import {
  NotificationProviderName,
  NotificationStatus,
  NotificationType,
} from '../enums/notification.enums';
import type { NotificationDataPayload } from '../notifications.types';

@Entity('notifications')
@Index('UQ_notifications_idempotency_key', ['idempotencyKey'], { unique: true })
@Index('IDX_notifications_recipient_user_id', ['recipientUserId'])
@Index('IDX_notifications_status', ['status'])
@Index('IDX_notifications_type', ['type'])
@Index('IDX_notifications_created_at', ['createdAt'])
export class Notification {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipient_user_id' })
  recipientUser!: User;

  @Column({ name: 'recipient_user_id', type: 'uuid' })
  recipientUserId!: string;

  @Column({
    type: 'enum',
    enum: NotificationType,
  })
  type!: NotificationType;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'varchar', length: 500 })
  body!: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  data!: NotificationDataPayload;

  @Column({
    type: 'enum',
    enum: NotificationStatus,
    default: NotificationStatus.PENDING,
  })
  status!: NotificationStatus;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @Column({
    type: 'enum',
    enum: NotificationProviderName,
    default: NotificationProviderName.FCM,
  })
  provider!: NotificationProviderName;

  @Column({
    name: 'provider_message_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  providerMessageId!: string | null;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt!: Date | null;

  @Column({
    name: 'failure_reason',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  failureReason!: string | null;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt!: Date | null;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = randomUUID();
    }
  }
}
