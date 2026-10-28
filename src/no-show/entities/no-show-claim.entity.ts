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
import { SupportTicket } from '../../support/entities/support-ticket.entity';
import { User } from '../../users/entities/user.entity';
import {
  NoShowClaimKind,
  NoShowClaimStatus,
  NoShowDecisionSource,
} from '../enums/no-show.enums';

@Entity('no_show_claims')
@Index('IDX_no_show_claims_ride_id', ['rideId'])
@Index('IDX_no_show_claims_booking_id', ['bookingId'])
@Index('IDX_no_show_claims_status_respond_by', ['status', 'respondBy'])
@Index('UQ_no_show_claims_pending_driver_ride', ['rideId'], {
  unique: true,
  where: `"status" = 'PENDING' AND "kind" = 'DRIVER_NO_SHOW'`,
})
@Index('UQ_no_show_claims_pending_passenger_booking', ['bookingId'], {
  unique: true,
  where: `"status" = 'PENDING' AND "kind" = 'PASSENGER_NO_SHOW' AND "booking_id" IS NOT NULL`,
})
@Index('UQ_no_show_claims_settlement_idempotency_key', ['settlementIdempotencyKey'], {
  unique: true,
  where: '"settlement_idempotency_key" IS NOT NULL',
})
export class NoShowClaim {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => Ride, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ride_id' })
  ride!: Ride;

  @Column({ name: 'ride_id', type: 'uuid' })
  rideId!: string;

  @ManyToOne(() => Booking, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'booking_id' })
  booking!: Booking | null;

  @Column({ name: 'booking_id', type: 'uuid', nullable: true })
  bookingId!: string | null;

  @Column({
    name: 'ride_type',
    type: 'enum',
    enum: RideType,
    enumName: 'rides_ride_type_enum',
  })
  rideType!: RideType;

  @Column({
    type: 'enum',
    enum: NoShowClaimKind,
  })
  kind!: NoShowClaimKind;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'claimant_user_id' })
  claimantUser!: User;

  @Column({ name: 'claimant_user_id', type: 'uuid' })
  claimantUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'respondent_user_id' })
  respondentUser!: User;

  @Column({ name: 'respondent_user_id', type: 'uuid' })
  respondentUserId!: string;

  @Column({
    type: 'enum',
    enum: NoShowClaimStatus,
    default: NoShowClaimStatus.PENDING,
  })
  status!: NoShowClaimStatus;

  @Column({ name: 'respond_by', type: 'timestamptz' })
  respondBy!: Date;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'responded_by_user_id' })
  respondedByUser!: User | null;

  @Column({ name: 'responded_by_user_id', type: 'uuid', nullable: true })
  respondedByUserId!: string | null;

  @Column({
    name: 'decision_source',
    type: 'enum',
    enum: NoShowDecisionSource,
    nullable: true,
  })
  decisionSource!: NoShowDecisionSource | null;

  @Column({ name: 'settled_at', type: 'timestamptz', nullable: true })
  settledAt!: Date | null;

  @Column({
    name: 'settlement_idempotency_key',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  settlementIdempotencyKey!: string | null;

  @ManyToOne(() => SupportTicket, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'support_ticket_id' })
  supportTicket!: SupportTicket | null;

  @Column({ name: 'support_ticket_id', type: 'uuid', nullable: true })
  supportTicketId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
