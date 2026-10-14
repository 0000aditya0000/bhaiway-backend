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
import {
  CouponBenefitType,
  CouponChargeScope,
  CouponRedemptionStatus,
  CouponRideTypeScope,
} from '../enums/coupon.enums';
import { Coupon } from './coupon.entity';

@Entity('coupon_redemptions')
@Index('IDX_coupon_redemptions_coupon_id', ['couponId'])
@Index('IDX_coupon_redemptions_user_id', ['userId'])
@Index('IDX_coupon_redemptions_booking_id', ['bookingId'])
@Index('UQ_coupon_redemptions_idempotency', ['idempotencyKey'], {
  unique: true,
  where: '"idempotency_key" IS NOT NULL',
})
export class CouponRedemption {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => Coupon, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'coupon_id' })
  coupon!: Coupon;

  @Column({ name: 'coupon_id', type: 'uuid' })
  couponId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({
    type: 'varchar',
    length: 32,
    default: CouponRedemptionStatus.RESERVED,
  })
  status!: CouponRedemptionStatus;

  @Column({ name: 'booking_id', type: 'uuid', nullable: true })
  bookingId!: string | null;

  @Column({ name: 'ride_id', type: 'uuid', nullable: true })
  rideId!: string | null;

  @Column({
    name: 'ride_type_scope',
    type: 'varchar',
    length: 32,
  })
  rideTypeScope!: CouponRideTypeScope;

  @Column({
    name: 'charge_scope',
    type: 'varchar',
    length: 40,
  })
  chargeScope!: CouponChargeScope;

  @Column({
    name: 'benefit_type_snapshot',
    type: 'varchar',
    length: 32,
  })
  benefitTypeSnapshot!: CouponBenefitType;

  @Column({ name: 'benefit_value_snapshot', type: 'bigint' })
  benefitValueSnapshot!: string;

  @Column({ name: 'code_snapshot', type: 'varchar', length: 64 })
  codeSnapshot!: string;

  @Column({ name: 'original_amount', type: 'bigint' })
  originalAmount!: string;

  @Column({ name: 'discount_amount', type: 'bigint', default: '0' })
  discountAmount!: string;

  @Column({ name: 'final_amount', type: 'bigint' })
  finalAmount!: string;

  @Column({ name: 'points_credited', type: 'bigint', nullable: true })
  pointsCredited!: string | null;

  @Column({ name: 'wallet_transaction_id', type: 'uuid', nullable: true })
  walletTransactionId!: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255, nullable: true })
  idempotencyKey!: string | null;

  /** Frozen coupon JSON for audit (never mutate after create). */
  @Column({ name: 'config_snapshot', type: 'jsonb' })
  configSnapshot!: Record<string, unknown>;

  @Column({ name: 'reserved_at', type: 'timestamptz', nullable: true })
  reservedAt!: Date | null;

  @Column({ name: 'redeemed_at', type: 'timestamptz', nullable: true })
  redeemedAt!: Date | null;

  @Column({ name: 'released_at', type: 'timestamptz', nullable: true })
  releasedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
