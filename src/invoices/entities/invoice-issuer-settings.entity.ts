import { randomUUID } from 'crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('invoice_issuer_settings')
export class InvoiceIssuerSettings {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'legal_name', type: 'varchar', length: 255 })
  legalName!: string;

  @Column({ type: 'varchar', length: 15 })
  gstin!: string;

  @Column({ name: 'address_line1', type: 'varchar', length: 255 })
  addressLine1!: string;

  @Column({ name: 'address_line2', type: 'varchar', length: 255, nullable: true })
  addressLine2!: string | null;

  @Column({ type: 'varchar', length: 100 })
  city!: string;

  @Column({ type: 'varchar', length: 100 })
  state!: string;

  @Column({ name: 'state_code', type: 'varchar', length: 2 })
  stateCode!: string;

  @Column({ name: 'pin_code', type: 'varchar', length: 6 })
  pinCode!: string;

  @Column({ name: 'contact_email', type: 'varchar', length: 255, nullable: true })
  contactEmail!: string | null;

  @Column({ name: 'contact_phone', type: 'varchar', length: 20, nullable: true })
  contactPhone!: string | null;

  @Column({ name: 'invoice_prefix', type: 'varchar', length: 16 })
  invoicePrefix!: string;

  @Column({ name: 'logo_storage_key', type: 'varchar', length: 512, nullable: true })
  logoStorageKey!: string | null;

  @Column({ name: 'footer_notes', type: 'text', nullable: true })
  footerNotes!: string | null;

  @Column({ name: 'updated_by_admin_user_id', type: 'uuid', nullable: true })
  updatedByAdminUserId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
