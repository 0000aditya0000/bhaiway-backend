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
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { ReferralStatus } from '../enums/referral.enums';

@Entity('referrals')
@Index('IDX_referrals_referrer_user_id', ['referrerUserId'])
@Index('IDX_referrals_referral_code', ['referralCode'])
@Index('UQ_referrals_referred_user_id', ['referredUserId'], { unique: true })
export class Referral {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'referrer_user_id' })
  referrer!: User;

  @Column({ name: 'referrer_user_id', type: 'uuid' })
  referrerUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'referred_user_id' })
  referred!: User;

  @Column({ name: 'referred_user_id', type: 'uuid' })
  referredUserId!: string;

  /** Snapshot of the referrer code used at registration. */
  @Column({ name: 'referral_code', type: 'varchar', length: 32 })
  referralCode!: string;

  @Column({
    type: 'varchar',
    length: 32,
    default: ReferralStatus.REWARDED,
  })
  status!: ReferralStatus;

  @Column({ name: 'reward_coins', type: 'bigint', default: '50' })
  rewardCoins!: string;

  @Column({ name: 'rewarded_at', type: 'timestamptz', nullable: true })
  rewardedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
