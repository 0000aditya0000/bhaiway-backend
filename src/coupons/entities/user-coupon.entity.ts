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
import { randomUUID } from 'crypto';

import { User } from '../../users/entities/user.entity';

export enum UserCouponType {
  NEXT_ASSURED_DEPOSIT_FREE = 'NEXT_ASSURED_DEPOSIT_FREE',
}

export enum UserCouponStatus {
  UNUSED = 'UNUSED',
  USED = 'USED',
}

@Entity('user_coupons')
@Index('IDX_user_coupons_user_id', ['userId'])
@Index('UQ_user_coupons_source', ['sourceReferenceType', 'sourceReferenceId'], {
  unique: true,
})
export class UserCoupon {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({
    name: 'coupon_type',
    type: 'enum',
    enum: UserCouponType,
  })
  couponType!: UserCouponType;

  @Column({
    type: 'enum',
    enum: UserCouponStatus,
    default: UserCouponStatus.UNUSED,
  })
  status!: UserCouponStatus;

  @Column({ name: 'source_reference_type', type: 'varchar', length: 50 })
  sourceReferenceType!: string;

  @Column({ name: 'source_reference_id', type: 'varchar', length: 255 })
  sourceReferenceId!: string;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @Column({ name: 'used_booking_id', type: 'uuid', nullable: true })
  usedBookingId!: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
