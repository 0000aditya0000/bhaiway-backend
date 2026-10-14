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
  CouponIssuanceSource,
  CouponIssuanceStatus,
} from '../enums/coupon.enums';
import { Coupon } from './coupon.entity';

@Entity('coupon_issuances')
@Index('UQ_coupon_issuances_idempotency', ['idempotencyKey'], { unique: true })
@Index('IDX_coupon_issuances_user_id', ['userId'])
@Index('IDX_coupon_issuances_trip_id', ['tripId'])
@Index('IDX_coupon_issuances_rule', ['ruleIdentifier', 'ruleVersion'])
export class CouponIssuance {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => Coupon, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'coupon_id' })
  coupon!: Coupon | null;

  @Column({ name: 'coupon_id', type: 'uuid', nullable: true })
  couponId!: string | null;

  @Column({
    type: 'varchar',
    length: 48,
  })
  source!: CouponIssuanceSource;

  @Column({ type: 'varchar', length: 160, nullable: true })
  reason!: string | null;

  @Column({ name: 'rule_identifier', type: 'varchar', length: 120, nullable: true })
  ruleIdentifier!: string | null;

  @Column({ name: 'rule_version', type: 'int', nullable: true })
  ruleVersion!: number | null;

  @Column({ name: 'trip_id', type: 'uuid', nullable: true })
  tripId!: string | null;

  @Column({
    type: 'varchar',
    length: 32,
    default: CouponIssuanceStatus.PENDING,
  })
  status!: CouponIssuanceStatus;

  @Column({ name: 'benefit_snapshot', type: 'jsonb', nullable: true })
  benefitSnapshot!: Record<string, unknown> | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @Column({ name: 'failure_message', type: 'text', nullable: true })
  failureMessage!: string | null;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;

  @Column({ name: 'issued_at', type: 'timestamptz', nullable: true })
  issuedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
