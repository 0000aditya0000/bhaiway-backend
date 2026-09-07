import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { randomUUID } from 'crypto';
import { PaymentOrderProvider } from '../enums/payment-order.enums';

export enum WebhookProcessingStatus {
  PENDING = 'PENDING',
  PROCESSED = 'PROCESSED',
  FAILED = 'FAILED',
  IGNORED = 'IGNORED',
}

@Entity('payment_webhook_events')
@Index('UQ_payment_webhook_events_provider_event_id', ['provider', 'eventId'], {
  unique: true,
})
@Index('IDX_payment_webhook_events_gateway_order_id', ['gatewayOrderId'])
export class PaymentWebhookEvent {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({
    type: 'enum',
    enum: PaymentOrderProvider,
  })
  provider!: PaymentOrderProvider;

  @Column({
    name: 'event_id',
    type: 'varchar',
    length: 255,
  })
  eventId!: string;

  @Column({
    name: 'event_type',
    type: 'varchar',
    length: 100,
  })
  eventType!: string;

  @Column({
    type: 'enum',
    enum: WebhookProcessingStatus,
    default: WebhookProcessingStatus.PENDING,
  })
  status!: WebhookProcessingStatus;

  @Column({
    name: 'gateway_order_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  gatewayOrderId!: string | null;

  @Column({
    name: 'gateway_payment_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  gatewayPaymentId!: string | null;

  @Column({
    name: 'failure_reason',
    type: 'text',
    nullable: true,
  })
  failureReason!: string | null;

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  payload!: Record<string, unknown> | null;

  @CreateDateColumn({
    name: 'received_at',
    type: 'timestamptz',
  })
  receivedAt!: Date;

  @Column({
    name: 'processed_at',
    type: 'timestamptz',
    nullable: true,
  })
  processedAt!: Date | null;

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
