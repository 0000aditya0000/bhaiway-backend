import {
  BeforeInsert,
  Check,
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
import {
  PaymentOrderProvider,
  PaymentOrderStatus,
} from '../enums/payment-order.enums';
import { WalletTransaction } from './wallet-transaction.entity';
import { Wallet } from './wallet.entity';

/**
 * Real-money top-up / payment provider order.
 * Distinct from wallet_transactions — credits happen only after verified SUCCESS.
 */
@Entity('payment_orders')
@Index('IDX_payment_orders_user_id', ['userId'])
@Index('IDX_payment_orders_status', ['status'])
@Index('UQ_payment_orders_gateway_order_id', ['gatewayOrderId'], {
  unique: true,
  where: '"gateway_order_id" IS NOT NULL',
})
@Index('UQ_payment_orders_idempotency_key', ['idempotencyKey'], {
  unique: true,
  where: '"idempotency_key" IS NOT NULL',
})
@Check(`"amount" > 0`)
export class PaymentOrder {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => User, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({
    name: 'user_id',
    type: 'uuid',
  })
  userId!: string;

  @ManyToOne(() => Wallet, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'wallet_id' })
  wallet!: Wallet;

  @Column({
    name: 'wallet_id',
    type: 'uuid',
  })
  walletId!: string;

  /** Integer coins/points (1 = ₹1). */
  @Column({
    type: 'bigint',
  })
  amount!: string;

  @Column({
    type: 'varchar',
    length: 3,
    default: 'INR',
  })
  currency!: string;

  @Column({
    type: 'enum',
    enum: PaymentOrderProvider,
  })
  provider!: PaymentOrderProvider;

  /** Assigned after gateway order creation; null while PENDING pre-gateway. */
  @Column({
    name: 'gateway_order_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  gatewayOrderId!: string | null;

  @Column({
    type: 'enum',
    enum: PaymentOrderStatus,
    default: PaymentOrderStatus.PENDING,
  })
  status!: PaymentOrderStatus;

  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  idempotencyKey!: string | null;

  @ManyToOne(() => WalletTransaction, {
    onDelete: 'RESTRICT',
    nullable: true,
  })
  @JoinColumn({ name: 'wallet_transaction_id' })
  walletTransaction!: WalletTransaction | null;

  @Column({
    name: 'wallet_transaction_id',
    type: 'uuid',
    nullable: true,
  })
  walletTransactionId!: string | null;

  @Column({
    name: 'callback_reference',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  callbackReference!: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
  })
  createdAt!: Date;

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
