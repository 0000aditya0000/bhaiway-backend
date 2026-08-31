import {
  BeforeInsert,
  Check,
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

import { Ride } from '../../rides/entities/ride.entity';
import { User } from '../../users/entities/user.entity';
import { WalletTransaction } from '../../wallet/entities/wallet-transaction.entity';
import {
  BookingCancellationReason,
  BookingFarePayment,
  BookingMode,
  BookingPaymentMethod,
  BookingPaymentStatus,
  BookingPickupStatus,
  BookingStatus,
} from '../enums/booking.enums';

/**
 * Passenger seat reservation against a published ride.
 *
 * price_per_seat_snapshot and total_amount are integer points (1 point = ₹1).
 * Wallet ledger remains the financial source of truth for PAY_NOW.
 */
@Entity('bookings')
@Index('IDX_bookings_passenger_id', ['passengerId'])
@Index('IDX_bookings_ride_id', ['rideId'])
@Index('UQ_bookings_active_passenger_ride', ['passengerId', 'rideId'], {
  unique: true,
  where: `"status" IN ('PENDING', 'CONFIRMED')`,
})
@Index('UQ_bookings_idempotency_key', ['idempotencyKey'], {
  unique: true,
  where: '"idempotency_key" IS NOT NULL',
})
@Check(`"seats" > 0`)
@Check(`"price_per_seat_snapshot" >= 0`)
@Check(`"total_amount" >= 0`)
export class Booking {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => Ride, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'ride_id' })
  ride!: Ride;

  @Column({
    name: 'ride_id',
    type: 'uuid',
  })
  rideId!: string;

  @ManyToOne(() => User, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'passenger_id' })
  passenger!: User;

  @Column({
    name: 'passenger_id',
    type: 'uuid',
  })
  passengerId!: string;

  @Column({
    type: 'int',
  })
  seats!: number;

  @Column({
    type: 'enum',
    enum: BookingStatus,
    default: BookingStatus.CONFIRMED,
  })
  status!: BookingStatus;

  @Column({
    name: 'payment_method',
    type: 'enum',
    enum: BookingPaymentMethod,
  })
  paymentMethod!: BookingPaymentMethod;

  @Column({
    name: 'payment_status',
    type: 'enum',
    enum: BookingPaymentStatus,
  })
  paymentStatus!: BookingPaymentStatus;

  /**
   * Assured fare choice (PAY_NOW | PAY_LATER) when paymentMethod is ASSURED_DEPOSIT.
   * Null for Regular bookings.
   */
  @Column({
    name: 'fare_payment_method',
    type: 'enum',
    enum: BookingFarePayment,
    nullable: true,
  })
  farePaymentMethod!: BookingFarePayment | null;

  /** Ride price at booking time (integer points). */
  @Column({
    name: 'price_per_seat_snapshot',
    type: 'bigint',
  })
  pricePerSeatSnapshot!: string;

  /** price_per_seat_snapshot × seats (integer points). */
  @Column({
    name: 'total_amount',
    type: 'bigint',
  })
  totalAmount!: string;

  /** COMMUTE: driver-published fare per seat at booking time. Null for Regular/Assured. */
  @Column({
    name: 'driver_price_per_seat_snapshot',
    type: 'bigint',
    nullable: true,
  })
  driverPricePerSeatSnapshot!: string | null;

  /** COMMUTE: passenger-facing fare per seat at booking time. Null for Regular/Assured. */
  @Column({
    name: 'rider_price_per_seat_snapshot',
    type: 'bigint',
    nullable: true,
  })
  riderPricePerSeatSnapshot!: string | null;

  /** COMMUTE: eventual driver share (driver fare × seats). Null until settlement phase. */
  @Column({
    name: 'driver_share_amount',
    type: 'bigint',
    nullable: true,
  })
  driverShareAmount!: string | null;

  /** COMMUTE: eventual BhaiWay margin (rider paid − driver share). Not a separate platform fee. */
  @Column({
    name: 'platform_share_amount',
    type: 'bigint',
    nullable: true,
  })
  platformShareAmount!: string | null;

  /** COMMUTE: timestamp when driver/platform shares were credited at ride completion. */
  @Column({
    name: 'settled_at',
    type: 'timestamptz',
    nullable: true,
  })
  settledAt!: Date | null;

  /**
   * Client Idempotency-Key for PAY_NOW (also used as wallet ledger key).
   * Null for PAY_LATER.
   */
  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  idempotencyKey!: string | null;

  /** Optional link to BOOKING_PAYMENT ledger row (wallet remains source of truth). */
  @ManyToOne(() => WalletTransaction, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'wallet_transaction_id' })
  walletTransaction!: WalletTransaction | null;

  @Column({
    name: 'wallet_transaction_id',
    type: 'uuid',
    nullable: true,
  })
  walletTransactionId!: string | null;

  /** Snapshot of deposit % used for this Assured booking. Null for Regular. */
  @Column({
    name: 'assured_deposit_percentage',
    type: 'int',
    nullable: true,
  })
  assuredDepositPercentage!: number | null;

  @Column({
    name: 'assured_deposit_reason',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  assuredDepositReason!: string | null;

  /** Rider Assured deposit amount in points. Null for Regular. */
  @Column({
    name: 'assured_deposit_amount',
    type: 'bigint',
    nullable: true,
  })
  assuredDepositAmount!: string | null;

  @Column({
    name: 'wallet_hold_id',
    type: 'uuid',
    nullable: true,
  })
  walletHoldId!: string | null;

  /**
   * Assured PAY_NOW fare debit ledger row. Distinct from wallet_transaction_id
   * (which remains the Assured deposit-hold ledger for Assured bookings).
   */
  @Column({
    name: 'fare_wallet_transaction_id',
    type: 'uuid',
    nullable: true,
  })
  fareWalletTransactionId!: string | null;

  /** Snapshot of Assured vs Regular rules that applied at booking time. */
  @Column({
    name: 'booking_mode',
    type: 'enum',
    enum: BookingMode,
    default: BookingMode.REGULAR,
  })
  bookingMode!: BookingMode;

  @Column({
    name: 'cancelled_at',
    type: 'timestamptz',
    nullable: true,
  })
  cancelledAt!: Date | null;

  @Column({
    name: 'cancellation_reason',
    type: 'enum',
    enum: BookingCancellationReason,
    nullable: true,
  })
  cancellationReason!: BookingCancellationReason | null;

  @Column({
    name: 'deposit_coupon_id',
    type: 'uuid',
    nullable: true,
  })
  depositCouponId!: string | null;

  /**
   * HMAC-SHA256 of pickup OTP (Regular rides). Never expose to clients.
   */
  @Column({
    name: 'pickup_otp_hash',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  pickupOtpHash!: string | null;

  /**
   * AES-GCM ciphertext of the rider-display OTP. Decrypt only for booking owner.
   */
  @Column({
    name: 'pickup_otp_ciphertext',
    type: 'text',
    nullable: true,
  })
  pickupOtpCiphertext!: string | null;

  @Column({
    name: 'pickup_status',
    type: 'enum',
    enum: BookingPickupStatus,
    nullable: true,
  })
  pickupStatus!: BookingPickupStatus | null;

  @Column({
    name: 'pickup_verified_at',
    type: 'timestamptz',
    nullable: true,
  })
  pickupVerifiedAt!: Date | null;

  @Column({
    name: 'pickup_otp_failed_attempts',
    type: 'int',
    default: 0,
  })
  pickupOtpFailedAttempts!: number;

  @Column({
    name: 'pickup_otp_expires_at',
    type: 'timestamptz',
    nullable: true,
  })
  pickupOtpExpiresAt!: Date | null;

  /** Deterministic boarding order within a Regular ride (1-based). */
  @Column({
    name: 'pickup_order',
    type: 'int',
    nullable: true,
  })
  pickupOrder!: number | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
  })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
