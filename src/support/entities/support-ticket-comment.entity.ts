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
import { SupportCommentAuthorType } from '../enums/support.enums';
import { SupportTicket } from './support-ticket.entity';

@Entity('support_ticket_comments')
@Index('IDX_support_ticket_comments_ticket_id', ['ticketId'])
@Index('IDX_support_ticket_comments_ticket_created', ['ticketId', 'createdAt'])
export class SupportTicketComment {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => SupportTicket, (t) => t.comments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket!: SupportTicket;

  @Column({ name: 'ticket_id', type: 'uuid' })
  ticketId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'author_user_id' })
  authorUser!: User;

  @Column({ name: 'author_user_id', type: 'uuid' })
  authorUserId!: string;

  @Column({
    name: 'author_type',
    type: 'enum',
    enum: SupportCommentAuthorType,
  })
  authorType!: SupportCommentAuthorType;

  @Column({ type: 'text' })
  message!: string;

  /** When true, comment is hidden from the ticket owner. */
  @Column({ name: 'is_internal', type: 'boolean', default: false })
  isInternal!: boolean;

  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  idempotencyKey!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
