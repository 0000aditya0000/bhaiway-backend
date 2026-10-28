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

import { Booking } from '../../bookings/entities/booking.entity';
import { Ride } from '../../rides/entities/ride.entity';
import { RideType } from '../../rides/enums/ride.enums';
import { User } from '../../users/entities/user.entity';
import {
  InvoiceEmailStatus,
  InvoiceGstSplit,
  InvoicePaymentStatus,
  InvoicePlaceOfSupplyMode,
  InvoiceTaxPricingMode,
} from '../enums/invoice.enums';

@Entity('gst_invoices')
@Index('UQ_gst_invoices_booking_id', ['bookingId'], { unique: true })
@Index('UQ_gst_invoices_invoice_number', ['invoiceNumber'], { unique: true })
@Index('IDX_gst_invoices_rider_user_id', ['riderUserId'])
@Index('IDX_gst_invoices_ride_id', ['rideId'])
@Index('IDX_gst_invoices_issued_at', ['issuedAt'])
export class GstInvoice {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'invoice_number', type: 'varchar', length: 48 })
  invoiceNumber!: string;

  @ManyToOne(() => Ride, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ride_id' })
  ride!: Ride;

  @Column({ name: 'ride_id', type: 'uuid' })
  rideId!: string;

  @ManyToOne(() => Booking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'booking_id' })
  booking!: Booking;

  @Column({ name: 'booking_id', type: 'uuid' })
  bookingId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'rider_user_id' })
  riderUser!: User;

  @Column({ name: 'rider_user_id', type: 'uuid' })
  riderUserId!: string;

  @Column({
    name: 'ride_type',
    type: 'enum',
    enum: RideType,
  })
  rideType!: RideType;

  @Column({ name: 'rider_name', type: 'varchar', length: 150, nullable: true })
  riderName!: string | null;

  @Column({ name: 'rider_email', type: 'varchar', length: 255, nullable: true })
  riderEmail!: string | null;

  @Column({ name: 'rider_phone', type: 'varchar', length: 20, nullable: true })
  riderPhone!: string | null;

  @Column({
    name: 'rider_billing_state_code',
    type: 'varchar',
    length: 2,
    nullable: true,
  })
  riderBillingStateCode!: string | null;

  @Column({ name: 'driver_name', type: 'varchar', length: 150, nullable: true })
  driverName!: string | null;

  @Column({
    name: 'vehicle_registration_number',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  vehicleRegistrationNumber!: string | null;

  @Column({ type: 'varchar', length: 255 })
  source!: string;

  @Column({ type: 'varchar', length: 255 })
  destination!: string;

  @Column({ name: 'departure_at', type: 'timestamptz', nullable: true })
  departureAt!: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ name: 'issued_at', type: 'timestamptz' })
  issuedAt!: Date;

  @Column({ name: 'gross_fare_paise', type: 'bigint' })
  grossFarePaise!: string;

  @Column({ name: 'discount_paise', type: 'bigint' })
  discountPaise!: string;

  @Column({ name: 'net_fare_paise', type: 'bigint' })
  netFarePaise!: string;

  @Column({ name: 'taxable_value_paise', type: 'bigint' })
  taxableValuePaise!: string;

  @Column({ name: 'gst_rate_basis_points', type: 'int' })
  gstRateBasisPoints!: number;

  @Column({ name: 'cgst_paise', type: 'bigint' })
  cgstPaise!: string;

  @Column({ name: 'sgst_paise', type: 'bigint' })
  sgstPaise!: string;

  @Column({ name: 'igst_paise', type: 'bigint' })
  igstPaise!: string;

  @Column({ name: 'total_tax_paise', type: 'bigint' })
  totalTaxPaise!: string;

  @Column({ name: 'invoice_total_paise', type: 'bigint' })
  invoiceTotalPaise!: string;

  @Column({
    name: 'pricing_mode',
    type: 'enum',
    enum: InvoiceTaxPricingMode,
  })
  pricingMode!: InvoiceTaxPricingMode;

  @Column({
    name: 'gst_split',
    type: 'enum',
    enum: InvoiceGstSplit,
  })
  gstSplit!: InvoiceGstSplit;

  @Column({
    name: 'payment_status',
    type: 'enum',
    enum: InvoicePaymentStatus,
  })
  paymentStatus!: InvoicePaymentStatus;

  @Column({
    name: 'payment_reference',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  paymentReference!: string | null;

  @Column({ name: 'issuer_legal_name', type: 'varchar', length: 255 })
  issuerLegalName!: string;

  @Column({ name: 'issuer_gstin', type: 'varchar', length: 15 })
  issuerGstin!: string;

  @Column({ name: 'issuer_address', type: 'text' })
  issuerAddress!: string;

  @Column({ name: 'issuer_state', type: 'varchar', length: 100 })
  issuerState!: string;

  @Column({ name: 'issuer_state_code', type: 'varchar', length: 2 })
  issuerStateCode!: string;

  @Column({ name: 'sac_code', type: 'varchar', length: 6 })
  sacCode!: string;

  @Column({ name: 'service_category', type: 'varchar', length: 120 })
  serviceCategory!: string;

  @Column({
    name: 'place_of_supply_mode',
    type: 'enum',
    enum: InvoicePlaceOfSupplyMode,
  })
  placeOfSupplyMode!: InvoicePlaceOfSupplyMode;

  @Column({ name: 'place_of_supply_state_code', type: 'varchar', length: 2 })
  placeOfSupplyStateCode!: string;

  @Column({ name: 'tax_config_id', type: 'uuid' })
  taxConfigId!: string;

  @Column({ name: 'tax_config_snapshot', type: 'jsonb' })
  taxConfigSnapshot!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 3, default: 'INR' })
  currency!: string;

  @Column({ name: 'pdf_storage_key', type: 'varchar', length: 512, nullable: true })
  pdfStorageKey!: string | null;

  @Column({ name: 'pdf_sha256', type: 'varchar', length: 64, nullable: true })
  pdfSha256!: string | null;

  @Column({
    name: 'email_status',
    type: 'enum',
    enum: InvoiceEmailStatus,
    default: InvoiceEmailStatus.PENDING,
  })
  emailStatus!: InvoiceEmailStatus;

  @Column({ name: 'email_attempt_count', type: 'int', default: 0 })
  emailAttemptCount!: number;

  @Column({ name: 'email_last_attempt_at', type: 'timestamptz', nullable: true })
  emailLastAttemptAt!: Date | null;

  @Column({ name: 'email_last_error', type: 'varchar', length: 500, nullable: true })
  emailLastError!: string | null;

  @Column({ name: 'email_sent_at', type: 'timestamptz', nullable: true })
  emailSentAt!: Date | null;

  @Column({ name: 'email_next_attempt_at', type: 'timestamptz', nullable: true })
  emailNextAttemptAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
