import { randomUUID } from 'crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { NotificationEmailDeliveryStatus } from '../enums/notification-email.enums';
import { Notification } from './notification.entity';

/**
 * Email outbox keyed 1:1 to notifications for idempotent verified-email delivery.
 * Independent of FCM push status.
 */
@Entity('notification_email_deliveries')
@Index('UQ_notification_email_deliveries_notification_id', ['notificationId'], {
  unique: true,
})
@Index('IDX_notification_email_deliveries_status_next', [
  'status',
  'nextAttemptAt',
])
export class NotificationEmailDelivery {
  @PrimaryColumn('uuid')
  id!: string;

  @OneToOne(() => Notification, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'notification_id' })
  notification!: Notification;

  @Column({ name: 'notification_id', type: 'uuid' })
  notificationId!: string;

  @Column({
    type: 'enum',
    enum: NotificationEmailDeliveryStatus,
    default: NotificationEmailDeliveryStatus.PENDING,
  })
  status!: NotificationEmailDeliveryStatus;

  @Column({
    name: 'recipient_email',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  recipientEmail!: string | null;

  @Column({ name: 'skip_reason', type: 'varchar', length: 255, nullable: true })
  skipReason!: string | null;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
