import { randomUUID } from 'crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import {
  CouponApplicableTo,
  CouponAudience,
  CouponBenefitType,
  CouponChargeScope,
  CouponRideTypeScope,
} from '../enums/coupon.enums';

@Entity('coupons')
@Index('UQ_coupons_code_normalized', ['codeNormalized'], { unique: true })
@Index('IDX_coupons_active_valid', ['isActive', 'startsAt', 'expiresAt'])
export class Coupon {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  code!: string;

  @Column({ name: 'code_normalized', type: 'varchar', length: 64 })
  codeNormalized!: string;

  @Column({ type: 'varchar', length: 120 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    name: 'benefit_type',
    type: 'varchar',
    length: 32,
  })
  benefitType!: CouponBenefitType;

  /** Points for POINTS_CREDIT/FIXED_DISCOUNT, or percent 1–100 for PERCENTAGE. */
  @Column({ name: 'benefit_value', type: 'bigint' })
  benefitValue!: string;

  @Column({
    name: 'max_discount_amount',
    type: 'bigint',
    nullable: true,
  })
  maxDiscountAmount!: string | null;

  @Column({
    name: 'min_eligible_amount',
    type: 'bigint',
    nullable: true,
  })
  minEligibleAmount!: string | null;

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
    type: 'varchar',
    length: 32,
  })
  audience!: CouponAudience;

  /**
   * Rider/driver redemption eligibility. Distinct from `audience`
   * (PUBLIC vs USER_SPECIFIC). Existing rows default to ALL.
   */
  @Column({
    name: 'applicable_to',
    type: 'varchar',
    length: 32,
    default: CouponApplicableTo.ALL,
  })
  applicableTo!: CouponApplicableTo;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'starts_at', type: 'timestamptz' })
  startsAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  /** Null = unlimited global redemptions. */
  @Column({ name: 'total_redemption_limit', type: 'int', nullable: true })
  totalRedemptionLimit!: number | null;

  /**
   * Per-user limit. Null = unlimited per user.
   * Single-use-per-user ⇒ 1.
   */
  @Column({ name: 'per_user_redemption_limit', type: 'int', nullable: true })
  perUserRedemptionLimit!: number | null;

  /** Cached count of REDEEMED (+ optionally RESERVED) — maintained by service. */
  @Column({ name: 'redeemed_count', type: 'int', default: 0 })
  redeemedCount!: number;

  @Column({ name: 'reserved_count', type: 'int', default: 0 })
  reservedCount!: number;

  @Column({ name: 'created_by_admin_id', type: 'uuid', nullable: true })
  createdByAdminId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
