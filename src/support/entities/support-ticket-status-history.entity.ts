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

import { SupportTicketStatus } from '../enums/support.enums';
import { SupportTicket } from './support-ticket.entity';

@Entity('support_ticket_status_history')
@Index('IDX_support_ticket_status_history_ticket_id', ['ticketId'])
export class SupportTicketStatusHistory {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => SupportTicket, (t) => t.statusHistory, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'ticket_id' })
  ticket!: SupportTicket;

  @Column({ name: 'ticket_id', type: 'uuid' })
  ticketId!: string;

  @Column({
    name: 'from_status',
    type: 'enum',
    enum: SupportTicketStatus,
    nullable: true,
  })
  fromStatus!: SupportTicketStatus | null;

  @Column({
    name: 'to_status',
    type: 'enum',
    enum: SupportTicketStatus,
  })
  toStatus!: SupportTicketStatus;

  @Column({ name: 'changed_by_user_id', type: 'uuid', nullable: true })
  changedByUserId!: string | null;

  @Column({ name: 'changed_by_admin', type: 'boolean', default: false })
  changedByAdmin!: boolean;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
