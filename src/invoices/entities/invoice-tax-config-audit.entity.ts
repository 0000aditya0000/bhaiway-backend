import { randomUUID } from 'crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity('invoice_tax_config_audit')
@Index('IDX_invoice_tax_config_audit_config_id', ['taxConfigId'])
export class InvoiceTaxConfigAudit {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'tax_config_id', type: 'uuid' })
  taxConfigId!: string;

  @Column({ name: 'admin_user_id', type: 'uuid', nullable: true })
  adminUserId!: string | null;

  @Column({ type: 'varchar', length: 40 })
  action!: string;

  @Column({ type: 'jsonb' })
  snapshot!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
