import { randomUUID } from 'crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity('coupon_audit_logs')
@Index('IDX_coupon_audit_logs_coupon_id', ['couponId'])
@Index('IDX_coupon_audit_logs_created_at', ['createdAt'])
export class CouponAuditLog {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'coupon_id', type: 'uuid', nullable: true })
  couponId!: string | null;

  @Column({ name: 'admin_id', type: 'uuid', nullable: true })
  adminId!: string | null;

  @Column({ type: 'varchar', length: 80 })
  action!: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
