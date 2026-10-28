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

import { RideType } from '../../rides/enums/ride.enums';
import {
  InvoicePlaceOfSupplyMode,
  InvoiceTaxConfigStatus,
  InvoiceTaxPricingMode,
} from '../enums/invoice.enums';

@Entity('invoice_tax_configs')
@Index('IDX_invoice_tax_configs_status_from', ['status', 'effectiveFrom'])
export class InvoiceTaxConfig {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'service_category', type: 'varchar', length: 120 })
  serviceCategory!: string;

  @Column({ name: 'ride_types', type: 'text', array: true })
  rideTypes!: RideType[];

  @Column({ name: 'sac_code', type: 'varchar', length: 6 })
  sacCode!: string;

  @Column({ name: 'gst_rate_basis_points', type: 'int' })
  gstRateBasisPoints!: number;

  @Column({
    name: 'pricing_mode',
    type: 'enum',
    enum: InvoiceTaxPricingMode,
  })
  pricingMode!: InvoiceTaxPricingMode;

  @Column({
    name: 'place_of_supply_mode',
    type: 'enum',
    enum: InvoicePlaceOfSupplyMode,
  })
  placeOfSupplyMode!: InvoicePlaceOfSupplyMode;

  @Column({ name: 'effective_from', type: 'timestamptz' })
  effectiveFrom!: Date;

  @Column({ name: 'effective_to', type: 'timestamptz', nullable: true })
  effectiveTo!: Date | null;

  @Column({
    type: 'enum',
    enum: InvoiceTaxConfigStatus,
    default: InvoiceTaxConfigStatus.DRAFT,
  })
  status!: InvoiceTaxConfigStatus;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ name: 'created_by_admin_user_id', type: 'uuid', nullable: true })
  createdByAdminUserId!: string | null;

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
