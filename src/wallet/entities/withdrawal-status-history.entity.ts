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
import { randomUUID } from 'crypto';

import { WithdrawalStatus } from '../enums/withdrawal.enums';
import { Withdrawal } from './withdrawal.entity';

@Entity('withdrawal_status_history')
@Index('IDX_withdrawal_status_history_withdrawal_id', ['withdrawalId'])
@Index('IDX_withdrawal_status_history_created_at', ['createdAt'])
export class WithdrawalStatusHistory {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => Withdrawal, (withdrawal) => withdrawal.statusHistory, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'withdrawal_id' })
  withdrawal!: Withdrawal;

  @Column({ name: 'withdrawal_id', type: 'uuid' })
  withdrawalId!: string;

  @Column({
    name: 'previous_status',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  previousStatus!: WithdrawalStatus | null;

  @Column({ name: 'new_status', type: 'varchar', length: 32 })
  newStatus!: WithdrawalStatus;

  /**
   * admin_users.id of the acting admin. FK (ON DELETE SET NULL) is defined in the
   * migration; no ORM relation so wallet-only modules need not register AdminUser.
   */
  @Column({ name: 'admin_user_id', type: 'uuid', nullable: true })
  adminUserId!: string | null;

  @Column({ type: 'text', nullable: true })
  remarks!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
