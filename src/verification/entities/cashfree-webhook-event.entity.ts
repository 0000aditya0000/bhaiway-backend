import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { randomUUID } from 'crypto';

@Entity('cashfree_webhook_events')
@Index('UQ_cashfree_webhook_events_provider_payload_hash', ['provider', 'payloadHash'], {
  unique: true,
})
@Index('IDX_cashfree_webhook_events_verification_id', ['verificationId'])
@Index('IDX_cashfree_webhook_events_reference_id', ['referenceId'])
export class CashfreeWebhookEvent {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({
    type: 'varchar',
    length: 50,
    default: 'CASHFREE',
  })
  provider!: string;

  @Column({
    name: 'event_type',
    type: 'varchar',
    length: 100,
  })
  eventType!: string;

  @Column({
    name: 'verification_id',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  verificationId!: string | null;

  @Column({
    name: 'reference_id',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  referenceId!: string | null;

  @Column({
    name: 'event_time',
    type: 'timestamptz',
    nullable: true,
  })
  eventTime!: Date | null;

  @Column({
    name: 'payload_hash',
    type: 'varchar',
    length: 64,
  })
  payloadHash!: string;

  @Column({
    type: 'boolean',
    default: false,
  })
  processed!: boolean;

  @Column({
    name: 'processed_at',
    type: 'timestamptz',
    nullable: true,
  })
  processedAt!: Date | null;

  @Column({
    name: 'failure_reason',
    type: 'text',
    nullable: true,
  })
  failureReason!: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
  })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
