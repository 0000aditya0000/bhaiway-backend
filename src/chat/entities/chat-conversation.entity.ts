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
import { randomUUID } from 'crypto';

import { Booking } from '../../bookings/entities/booking.entity';
import { Ride } from '../../rides/entities/ride.entity';
import { User } from '../../users/entities/user.entity';
import { ChatConversationStatus } from '../enums/chat.enums';

@Entity('chat_conversations')
@Index('UQ_chat_conversations_booking_id', ['bookingId'], { unique: true })
@Index('IDX_chat_conversations_ride_id', ['rideId'])
@Index('IDX_chat_conversations_driver_id', ['driverId'])
@Index('IDX_chat_conversations_passenger_id', ['passengerId'])
@Index('IDX_chat_conversations_status', ['status'])
@Index('IDX_chat_conversations_last_message_at', ['lastMessageAt'])
export class ChatConversation {
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
  @JoinColumn({ name: 'driver_id' })
  driver!: User;

  @Column({ name: 'driver_id', type: 'uuid' })
  driverId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'passenger_id' })
  passenger!: User;

  @Column({ name: 'passenger_id', type: 'uuid' })
  passengerId!: string;

  @Column({
    type: 'enum',
    enum: ChatConversationStatus,
    default: ChatConversationStatus.OPEN,
  })
  status!: ChatConversationStatus;

  @Column({ name: 'last_message_at', type: 'timestamptz', nullable: true })
  lastMessageAt!: Date | null;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = randomUUID();
    }
  }
}
