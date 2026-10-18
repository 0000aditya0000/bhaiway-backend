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

import { User } from '../../users/entities/user.entity';
import { SupportTicket } from './support-ticket.entity';

/**
 * Screenshot reference only — no binary storage in-DB.
 * Clients supply HTTPS image URLs (existing repo pattern; no upload pipeline).
 */
@Entity('support_ticket_attachments')
@Index('IDX_support_ticket_attachments_ticket_id', ['ticketId'])
export class SupportTicketAttachment {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => SupportTicket, (t) => t.attachments, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'ticket_id' })
  ticket!: SupportTicket;

  @Column({ name: 'ticket_id', type: 'uuid' })
  ticketId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'uploaded_by_user_id' })
  uploadedByUser!: User;

  @Column({ name: 'uploaded_by_user_id', type: 'uuid' })
  uploadedByUserId!: string;

  @Column({ type: 'varchar', length: 2048 })
  url!: string;

  @Column({ name: 'content_type', type: 'varchar', length: 64 })
  contentType!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
