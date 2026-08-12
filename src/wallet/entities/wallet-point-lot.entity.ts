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

export enum WalletPointSource {
  PURCHASED = 'PURCHASED',
  PROMOTIONAL = 'PROMOTIONAL',
  DRIVER_EARNED = 'DRIVER_EARNED',
}

@Entity('wallet_point_lots')
@Index('IDX_wallet_point_lots_wallet_id', ['walletId'])
@Index('IDX_wallet_point_lots_expires_at', ['expiresAt'])
@Check(`"original_amount" > 0`)
@Check(`"available_amount" >= 0`)
@Check(`"held_amount" >= 0`)
@Check(`"available_amount" + "held_amount" <= "original_amount"`)
export class WalletPointLot {
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
    name: 'source_type',
    type: 'enum',
    enum: WalletPointSource,
  })
  sourceType!: WalletPointSource;

  @Column({
    name: 'original_amount',
    type: 'bigint',
  })
  originalAmount!: string;

  @Column({
    name: 'available_amount',
    type: 'bigint',
  })
  availableAmount!: string;

  @Column({
    name: 'held_amount',
    type: 'bigint',
    default: 0,
  })
  heldAmount!: string;

  @Column({
    name: 'expires_at',
    type: 'timestamptz',
    nullable: true,
  })
  expiresAt!: Date | null;

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
