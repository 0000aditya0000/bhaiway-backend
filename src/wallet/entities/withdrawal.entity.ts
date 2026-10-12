import {
  BeforeInsert,
  Check,
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
import { randomUUID } from 'crypto';

import { User } from '../../users/entities/user.entity';
import {
  PaymentMethodType,
  WithdrawalProvider,
  WithdrawalStatus,
} from '../enums/withdrawal.enums';
import { UserPaymentMethod } from './user-payment-method.entity';
import { WithdrawalStatusHistory } from './withdrawal-status-history.entity';
import { Wallet } from './wallet.entity';

/**
 * Immutable copy of the payout destination at request time.
 * Never mutated after the withdrawal is created.
 * `accountNumberEncrypted` is ciphertext (admin-only decrypt for manual payout).
 */
export interface WithdrawalPaymentMethodSnapshot {
  type: PaymentMethodType;
  upiId: string | null;
  accountHolderName: string | null;
  accountNumberEncrypted: string | null;
  accountNumberLast4: string | null;
  ifscCode: string | null;
  bankName: string | null;
}

/**
 * Manual (admin-processed) withdrawal request.
 * Funds are reserved with a WITHDRAWAL wallet hold on DRIVER_EARNED lots only.
 */
@Entity('withdrawals')
@Index('IDX_withdrawals_user_id', ['userId'])
@Index('IDX_withdrawals_status', ['status'])
@Index('IDX_withdrawals_created_at', ['createdAt'])
@Index('UQ_withdrawals_reference_id', ['referenceId'], { unique: true })
@Index('UQ_withdrawals_user_idempotency_key', ['userId', 'idempotencyKey'], {
  unique: true,
})
@Check(`"amount" > 0`)
export class Withdrawal {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => Wallet, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'wallet_id' })
  wallet!: Wallet;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  /** Integer coins/points (1 Coin = 1 point = ₹1). */
  @Column({ type: 'bigint' })
  amount!: string;

  @Column({
    type: 'varchar',
    length: 32,
    default: WithdrawalStatus.INITIATED,
  })
  status!: WithdrawalStatus;

  @Column({
    type: 'varchar',
    length: 32,
    default: WithdrawalProvider.MANUAL,
  })
  provider!: string;

  @ManyToOne(() => UserPaymentMethod, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'payment_method_id' })
  paymentMethod!: UserPaymentMethod | null;

  @Column({ name: 'payment_method_id', type: 'uuid', nullable: true })
  paymentMethodId!: string | null;

  @Column({ name: 'payment_method_type', type: 'varchar', length: 32 })
  paymentMethodType!: PaymentMethodType;

  @Column({ name: 'payment_method_snapshot', type: 'jsonb' })
  paymentMethodSnapshot!: WithdrawalPaymentMethodSnapshot;

  @Column({ name: 'wallet_hold_id', type: 'uuid', nullable: true })
  walletHoldId!: string | null;

  /** Ledger transaction written when the hold was created. */
  @Column({ name: 'wallet_transaction_id', type: 'uuid', nullable: true })
  walletTransactionId!: string | null;

  @Column({ name: 'reference_id', type: 'varchar', length: 32 })
  referenceId!: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @Column({ name: 'admin_remarks', type: 'text', nullable: true })
  adminRemarks!: string | null;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => WithdrawalStatusHistory, (history) => history.withdrawal)
  statusHistory?: WithdrawalStatusHistory[];

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
