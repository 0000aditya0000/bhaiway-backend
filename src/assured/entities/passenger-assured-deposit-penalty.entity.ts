import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

export enum PassengerAssuredDepositPenaltyReason {
  PREVIOUS_ASSURED_CANCELLATION = 'PREVIOUS_ASSURED_CANCELLATION',
}

/**
 * Per-passenger temporary Assured deposit elevation (e.g. 10% after self-cancel).
 * Cleared after the passenger completes the next Assured ride booked under elevation.
 */
@Entity('passenger_assured_deposit_penalties')
@Index('IDX_passenger_assured_deposit_penalties_user_id', ['userId'])
export class PassengerAssuredDepositPenalty {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'elevated_percentage', type: 'integer' })
  elevatedPercentage!: number;

  @Column({
    type: 'enum',
    enum: PassengerAssuredDepositPenaltyReason,
  })
  reason!: PassengerAssuredDepositPenaltyReason;

  @Column({ name: 'source_cancellation_booking_id', type: 'uuid' })
  sourceCancellationBookingId!: string;

  @Column({ name: 'consumed_on_booking_id', type: 'uuid', nullable: true })
  consumedOnBookingId!: string | null;

  @Column({ name: 'cleared_at', type: 'timestamptz', nullable: true })
  clearedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
