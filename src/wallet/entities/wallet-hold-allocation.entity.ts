import {
  BeforeInsert,
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { randomUUID } from 'crypto';
import { WalletHold } from './wallet-hold.entity';
import { WalletPointLot } from './wallet-point-lot.entity';

@Entity('wallet_hold_allocations')
@Check(`"amount" > 0`)
export class WalletHoldAllocation {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => WalletHold, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'hold_id' })
  hold!: WalletHold;

  @Column({
    name: 'hold_id',
    type: 'uuid',
  })
  holdId!: string;

  @ManyToOne(() => WalletPointLot, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'point_lot_id' })
  pointLot!: WalletPointLot;

  @Column({
    name: 'point_lot_id',
    type: 'uuid',
  })
  pointLotId!: string;

  @Column({
    type: 'bigint',
  })
  amount!: string;

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
