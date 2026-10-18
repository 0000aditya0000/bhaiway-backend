import { randomUUID } from 'crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Booking } from '../../bookings/entities/booking.entity';
import { Ride } from '../../rides/entities/ride.entity';
import { User } from '../../users/entities/user.entity';
import { WalletTransaction } from '../../wallet/entities/wallet-transaction.entity';
import {
  SupportTicketCategory,
  SupportTicketStatus,
} from '../enums/support.enums';
import { SupportTicketAttachment } from './support-ticket-attachment.entity';
import { SupportTicketComment } from './support-ticket-comment.entity';
import { SupportTicketStatusHistory } from './support-ticket-status-history.entity';

@Entity('support_tickets')
@Index('UQ_support_tickets_reference', ['reference'], { unique: true })
@Index('IDX_support_tickets_user_id', ['userId'])
@Index('IDX_support_tickets_status', ['status'])
@Index('IDX_support_tickets_category', ['category'])
@Index('IDX_support_tickets_updated_at', ['updatedAt'])
@Index('IDX_support_tickets_user_updated', ['userId', 'updatedAt', 'id'])
export class SupportTicket {
  @PrimaryColumn('uuid')
  id!: string;

  /** User-facing ticket reference, e.g. SUP-A1B2C3D4 */
  @Column({ type: 'varchar', length: 32 })
  reference!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: SupportTicketCategory,
  })
  category!: SupportTicketCategory;

  @Column({ type: 'varchar', length: 64 })
  subcategory!: string;

  @Column({ type: 'varchar', length: 200 })
  subject!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({
    type: 'enum',
    enum: SupportTicketStatus,
    default: SupportTicketStatus.CREATED,
  })
  status!: SupportTicketStatus;

  @ManyToOne(() => Ride, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'related_ride_id' })
  relatedRide!: Ride | null;

  @Column({ name: 'related_ride_id', type: 'uuid', nullable: true })
  relatedRideId!: string | null;

  @ManyToOne(() => Booking, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'related_booking_id' })
  relatedBooking!: Booking | null;

  @Column({ name: 'related_booking_id', type: 'uuid', nullable: true })
  relatedBookingId!: string | null;

  @ManyToOne(() => WalletTransaction, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'related_wallet_transaction_id' })
  relatedWalletTransaction!: WalletTransaction | null;

  @Column({
    name: 'related_wallet_transaction_id',
    type: 'uuid',
    nullable: true,
  })
  relatedWalletTransactionId!: string | null;

  @Column({ name: 'assignee_admin_user_id', type: 'uuid', nullable: true })
  assigneeAdminUserId!: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  idempotencyKey!: string | null;

  @OneToMany(() => SupportTicketComment, (c) => c.ticket)
  comments!: SupportTicketComment[];

  @OneToMany(() => SupportTicketAttachment, (a) => a.ticket)
  attachments!: SupportTicketAttachment[];

  @OneToMany(() => SupportTicketStatusHistory, (h) => h.ticket)
  statusHistory!: SupportTicketStatusHistory[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
