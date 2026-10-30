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
} from 'typeorm';

import { Ride } from '../../rides/entities/ride.entity';
import { RideType, SeriesScope } from '../../rides/enums/ride.enums';
import { AdminUser } from './admin-user.entity';

export type AdminRideCancellationBookingSnapshot = {
  bookingId: string;
  passengerId: string;
  previousStatus: string;
  finalStatus: string;
  paymentMethod: string;
  paymentStatus: string;
  collectedAmount: string;
  pickupStatus: string | null;
  boarded: boolean;
  refundAmount: string;
  compensationAmount: string;
  depositReleasedAmount: string;
  supportEscalationRequired: boolean;
};

@Entity('admin_ride_cancellations')
@Index('IDX_admin_ride_cancellations_ride_id', ['rideId'])
@Index('IDX_admin_ride_cancellations_admin_user_id', ['adminUserId'])
@Index('IDX_admin_ride_cancellations_created_at', ['createdAt'])
@Index('UQ_admin_ride_cancellations_idempotency_key', ['idempotencyKey'], {
  unique: true,
})
export class AdminRideCancellation {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => AdminUser, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'admin_user_id' })
  adminUser!: AdminUser;

  @Column({ name: 'admin_user_id', type: 'uuid' })
  adminUserId!: string;

  @Column({ name: 'admin_actor_user_id', type: 'uuid' })
  adminActorUserId!: string;

  @ManyToOne(() => Ride, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'ride_id' })
  ride!: Ride;

  @Column({ name: 'ride_id', type: 'uuid' })
  rideId!: string;

  @Column({ name: 'ride_type', type: 'varchar', length: 32 })
  rideType!: RideType | string;

  @Column({ name: 'previous_status', type: 'varchar', length: 32 })
  previousStatus!: string;

  @Column({ name: 'final_status', type: 'varchar', length: 32 })
  finalStatus!: string;

  @Column({ type: 'varchar', length: 500 })
  reason!: string;

  @Column({ name: 'series_scope', type: 'varchar', length: 32, nullable: true })
  seriesScope!: SeriesScope | string | null;

  @Column({
    name: 'support_escalation_required',
    type: 'boolean',
    default: false,
  })
  supportEscalationRequired!: boolean;

  @Column({ name: 'refund_total', type: 'bigint', default: '0' })
  refundTotal!: string;

  @Column({ name: 'deposit_release_total', type: 'bigint', default: '0' })
  depositReleaseTotal!: string;

  @Column({ name: 'compensation_total', type: 'bigint', default: '0' })
  compensationTotal!: string;

  @Column({ name: 'already_applied', type: 'boolean', default: false })
  alreadyApplied!: boolean;

  @Column({ type: 'jsonb', default: [] })
  bookings!: AdminRideCancellationBookingSnapshot[];

  @Column({ name: 'financial_transaction_ids', type: 'jsonb', default: [] })
  financialTransactionIds!: string[];

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
