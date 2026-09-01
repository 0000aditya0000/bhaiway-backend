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

import { Booking } from '../../bookings/entities/booking.entity';
import { Ride } from '../../rides/entities/ride.entity';
import { User } from '../../users/entities/user.entity';
import { RatingTaskStatus } from '../enums/rating.enums';

/**
 * Directional post-ride rating obligation and submitted rating.
 * PENDING tasks remain eligible for reminders even after skip.
 */
@Entity('rating_tasks')
@Index('IDX_rating_tasks_from_user_id', ['fromUserId'])
@Index('IDX_rating_tasks_to_user_id', ['toUserId'])
@Index('IDX_rating_tasks_ride_id', ['rideId'])
@Index('IDX_rating_tasks_booking_id', ['bookingId'])
@Index('IDX_rating_tasks_status', ['status'])
@Index('IDX_rating_tasks_last_reminded_at', ['lastRemindedAt'])
@Index('UQ_rating_tasks_booking_direction', ['bookingId', 'fromUserId', 'toUserId'], {
  unique: true,
})
@Check(`"rating" IS NULL OR ("rating" >= 1 AND "rating" <= 5)`)
@Check(`"from_user_id" <> "to_user_id"`)
export class RatingTask {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => Ride, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'ride_id' })
  ride!: Ride;

  @Column({ name: 'ride_id', type: 'uuid' })
  rideId!: string;

  @ManyToOne(() => Booking, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'booking_id' })
  booking!: Booking;

  @Column({ name: 'booking_id', type: 'uuid' })
  bookingId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'from_user_id' })
  fromUser!: User;

  @Column({ name: 'from_user_id', type: 'uuid' })
  fromUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'to_user_id' })
  toUser!: User;

  @Column({ name: 'to_user_id', type: 'uuid' })
  toUserId!: string;

  @Column({
    type: 'enum',
    enum: RatingTaskStatus,
    default: RatingTaskStatus.PENDING,
  })
  status!: RatingTaskStatus;

  @Column({ type: 'smallint', nullable: true })
  rating!: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  comment!: string | null;

  @Column({ name: 'skipped_at', type: 'timestamptz', nullable: true })
  skippedAt!: Date | null;

  @Column({ name: 'last_reminded_at', type: 'timestamptz', nullable: true })
  lastRemindedAt!: Date | null;

  @Column({ name: 'reminder_count', type: 'int', default: 0 })
  reminderCount!: number;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
