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
import { Wallet } from './wallet.entity';

export enum WalletHoldType {
  ASSURED_DEPOSIT = 'ASSURED_DEPOSIT',
  BOOKING_PAYMENT = 'BOOKING_PAYMENT',
  WITHDRAWAL = 'WITHDRAWAL',
}

export enum WalletHoldStatus {
  ACTIVE = 'ACTIVE',
  RELEASED = 'RELEASED',
  CONSUMED = 'CONSUMED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}

@Entity('wallet_holds')
@Index('IDX_wallet_holds_wallet_id', ['walletId'])
@Index('IDX_wallet_holds_reference', ['referenceType', 'referenceId'])
@Check(`"amount" > 0`)
export class WalletHold {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => Wallet, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'wallet_id' })
  wallet!: Wallet;

  @Column({
    name: 'wallet_id',
    type: 'uuid',
  })
  walletId!: string;

  @Column({
    type: 'bigint',
  })
  amount!: string;

  @Column({
    name: 'hold_type',
    type: 'enum',
    enum: WalletHoldType,
  })
  holdType!: WalletHoldType;

  @Column({
    type: 'enum',
    enum: WalletHoldStatus,
    default: WalletHoldStatus.ACTIVE,
  })
  status!: WalletHoldStatus;

  @Column({
    name: 'reference_type',
    type: 'varchar',
    length: 50,
  })
  referenceType!: string;

  @Column({
    name: 'reference_id',
    type: 'varchar',
    length: 255,
  })
  referenceId!: string;

  @Column({
    name: 'expires_at',
    type: 'timestamptz',
    nullable: true,
  })
  expiresAt!: Date | null;

  @Column({
    name: 'released_at',
    type: 'timestamptz',
    nullable: true,
  })
  releasedAt!: Date | null;

  @Column({
    name: 'consumed_at',
    type: 'timestamptz',
    nullable: true,
  })
  consumedAt!: Date | null;

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
