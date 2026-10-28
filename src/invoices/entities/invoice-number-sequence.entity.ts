import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('invoice_number_sequences')
export class InvoiceNumberSequence {
  @PrimaryColumn({ name: 'series_prefix', type: 'varchar', length: 16 })
  seriesPrefix!: string;

  @PrimaryColumn({ name: 'financial_year', type: 'varchar', length: 16 })
  financialYear!: string;

  @Column({ name: 'last_value', type: 'int' })
  lastValue!: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
