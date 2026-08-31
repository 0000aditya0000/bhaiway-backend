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
} from 'typeorm';
import { randomUUID } from 'crypto';
import { User } from '../../users/entities/user.entity';
import { Wallet } from './wallet.entity';
import { WalletPointSource } from './wallet-point-lot.entity';

export enum WalletTransactionType {
  POINT_PURCHASE = 'POINT_PURCHASE',
  PROMOTIONAL_CREDIT = 'PROMOTIONAL_CREDIT',
  DRIVER_EARNING = 'DRIVER_EARNING',
  BOOKING_PAYMENT = 'BOOKING_PAYMENT',
  /** Commute completion: BhaiWay margin from rider upfront payment (not a separate platform fee). */
  COMMUTE_PLATFORM_MARGIN = 'COMMUTE_PLATFORM_MARGIN',
  ASSURED_DEPOSIT_HOLD = 'ASSURED_DEPOSIT_HOLD',
  HOLD_RELEASE = 'HOLD_RELEASE',
  HOLD_CONSUMED = 'HOLD_CONSUMED',
  REFUND = 'REFUND',
  NO_SHOW_FORFEITURE = 'NO_SHOW_FORFEITURE',
  ASSURED_RIDER_COMPENSATION = 'ASSURED_RIDER_COMPENSATION',
  ASSURED_PARTIAL_FILL_COMPENSATION = 'ASSURED_PARTIAL_FILL_COMPENSATION',
  ASSURED_PLATFORM_FORFEITURE = 'ASSURED_PLATFORM_FORFEITURE',
  ASSURED_PASSENGER_CANCEL_DEPOSIT_DRIVER = 'ASSURED_PASSENGER_CANCEL_DEPOSIT_DRIVER',
  ASSURED_PASSENGER_CANCEL_FARE_DRIVER = 'ASSURED_PASSENGER_CANCEL_FARE_DRIVER',
  ASSURED_PASSENGER_CANCEL_FARE_PLATFORM = 'ASSURED_PASSENGER_CANCEL_FARE_PLATFORM',
  /** Opening platform operating float (audit of seed; not a user purchase). */
  PLATFORM_SEED = 'PLATFORM_SEED',
  WITHDRAWAL = 'WITHDRAWAL',
  WITHDRAWAL_REVERSAL = 'WITHDRAWAL_REVERSAL',
  ADMIN_ADJUSTMENT = 'ADMIN_ADJUSTMENT',
}

export enum WalletTransactionDirection {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
}

export enum WalletTransactionStatus {
  POSTED = 'POSTED',
  REVERSED = 'REVERSED',
}

@Entity('wallet_transactions')
@Index('IDX_wallet_transactions_wallet_id', ['walletId'])
@Index('IDX_wallet_transactions_reference', ['referenceType', 'referenceId'])
@Index('UQ_wallet_transactions_idempotency_key', ['idempotencyKey'], {
  unique: true,
})
@Check(`"amount" > 0`)
@Check(`"balance_before" >= 0`)
@Check(`"balance_after" >= 0`)
export class WalletTransaction {
  @PrimaryColumn('uuid')
  id!: string;

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

  @Column({
    name: 'transaction_type',
    type: 'enum',
    enum: WalletTransactionType,
  })
  transactionType!: WalletTransactionType;

  @Column({
    name: 'point_source',
    type: 'enum',
    enum: WalletPointSource,
    nullable: true,
  })
  pointSource!: WalletPointSource | null;

  @Column({
    type: 'enum',
    enum: WalletTransactionDirection,
  })
  direction!: WalletTransactionDirection;

  @Column({
    type: 'bigint',
  })
  amount!: string;

  @Column({
    name: 'balance_before',
    type: 'bigint',
  })
  balanceBefore!: string;

  @Column({
    name: 'balance_after',
    type: 'bigint',
  })
  balanceAfter!: string;

  @Column({
    name: 'reference_type',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  referenceType!: string | null;

  @Column({
    name: 'reference_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  referenceId!: string | null;

  @Column({
    name: 'parent_transaction_id',
    type: 'uuid',
    nullable: true,
  })
  parentTransactionId!: string | null;

  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    length: 255,
  })
  idempotencyKey!: string;

  @Column({
    type: 'enum',
    enum: WalletTransactionStatus,
    default: WalletTransactionStatus.POSTED,
  })
  status!: WalletTransactionStatus;

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
