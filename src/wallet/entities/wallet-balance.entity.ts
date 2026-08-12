import {
  BeforeInsert,
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { randomUUID } from 'crypto';
import { Wallet } from './wallet.entity';

@Entity('wallet_balances')
@Check(
  `"purchased_available" >= 0 AND "promotional_available" >= 0 AND "driver_earned_available" >= 0 AND "purchased_held" >= 0 AND "promotional_held" >= 0 AND "driver_earned_held" >= 0`,
)
export class WalletBalance {
  @PrimaryColumn('uuid')
  id!: string;

  @OneToOne(() => Wallet, {
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
    name: 'purchased_available',
    type: 'bigint',
    default: 0,
  })
  purchasedAvailable!: string;

  @Column({
    name: 'promotional_available',
    type: 'bigint',
    default: 0,
  })
  promotionalAvailable!: string;

  @Column({
    name: 'driver_earned_available',
    type: 'bigint',
    default: 0,
  })
  driverEarnedAvailable!: string;

  @Column({
    name: 'purchased_held',
    type: 'bigint',
    default: 0,
  })
  purchasedHeld!: string;

  @Column({
    name: 'promotional_held',
    type: 'bigint',
    default: 0,
  })
  promotionalHeld!: string;

  @Column({
    name: 'driver_earned_held',
    type: 'bigint',
    default: 0,
  })
  driverEarnedHeld!: string;

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
