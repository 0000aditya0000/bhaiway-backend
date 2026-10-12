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
import { PaymentMethodType } from '../enums/withdrawal.enums';

/**
 * Saved payout destination (UPI or bank account) for manual withdrawals.
 * Bank account numbers are encrypted at rest (AES-256-GCM); only last4 is stored in clear.
 */
@Entity('user_payment_methods')
@Index('IDX_user_payment_methods_user_id', ['userId'])
@Index('IDX_user_payment_methods_user_active', ['userId', 'isActive'])
export class UserPaymentMethod {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 32 })
  type!: PaymentMethodType;

  @Column({ name: 'upi_id', type: 'varchar', length: 255, nullable: true })
  upiId!: string | null;

  @Column({
    name: 'account_holder_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  accountHolderName!: string | null;

  @Column({ name: 'account_number_encrypted', type: 'text', nullable: true })
  accountNumberEncrypted!: string | null;

  @Column({
    name: 'account_number_last4',
    type: 'varchar',
    length: 4,
    nullable: true,
  })
  accountNumberLast4!: string | null;

  @Column({ name: 'ifsc_code', type: 'varchar', length: 11, nullable: true })
  ifscCode!: string | null;

  @Column({ name: 'bank_name', type: 'varchar', length: 255, nullable: true })
  bankName!: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
