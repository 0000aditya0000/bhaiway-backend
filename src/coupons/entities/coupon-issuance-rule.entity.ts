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

/**
 * Future automatic issuance rules. Inactive by default.
 * No rule is activated in this delivery.
 */
@Entity('coupon_issuance_rules')
@Index('UQ_coupon_issuance_rules_identifier_version', [
  'ruleIdentifier',
  'ruleVersion',
], { unique: true })
export class CouponIssuanceRule {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'rule_identifier', type: 'varchar', length: 120 })
  ruleIdentifier!: string;

  @Column({ name: 'rule_version', type: 'int', default: 1 })
  ruleVersion!: number;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Must remain false until explicitly activated by ops/product. */
  @Column({ name: 'is_active', type: 'boolean', default: false })
  isActive!: boolean;

  /**
   * Opaque condition/benefit config for future evaluation.
   * Shape is intentionally flexible; evaluator is not enabled yet.
   */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  config!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
