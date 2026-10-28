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

import { User } from '../../users/entities/user.entity';
import { Vehicle } from '../../vehicles/entities/vehicle.entity';
import {
  RideSeriesStatus,
  RideType,
  Weekday,
} from '../enums/ride.enums';
import type { SelectedRouteFields } from '../route/route-selection.service';

export type CommuteRouteSnapshot = SelectedRouteFields & {
  source: string;
  destination: string;
};

@Entity('ride_series')
@Index('IDX_ride_series_driver_id', ['driverId'])
@Index('UQ_ride_series_publish_idempotency_key', ['publishIdempotencyKey'], {
  unique: true,
  where: '"publish_idempotency_key" IS NOT NULL',
})
export class RideSeries {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'driver_id' })
  driver!: User;

  @Column({ name: 'driver_id', type: 'uuid' })
  driverId!: string;

  @ManyToOne(() => Vehicle, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'vehicle_id' })
  vehicle!: Vehicle;

  @Column({ name: 'vehicle_id', type: 'uuid' })
  vehicleId!: string;

  @Column({
    name: 'ride_type',
    type: 'enum',
    enum: RideType,
    enumName: 'rides_ride_type_enum',
    default: RideType.COMMUTE,
  })
  rideType!: RideType;

  @Column({
    type: 'enum',
    enum: RideSeriesStatus,
    enumName: 'ride_series_status_enum',
    default: RideSeriesStatus.ACTIVE,
  })
  status!: RideSeriesStatus;

  @Column({ name: 'publishing_date', type: 'date' })
  publishingDate!: string;

  @Column({ name: 'start_date', type: 'date' })
  startDate!: string;

  @Column({ name: 'end_date', type: 'date' })
  endDate!: string;

  @Column({
    name: 'excluded_weekdays',
    type: 'enum',
    enum: Weekday,
    enumName: 'ride_series_weekday_enum',
    array: true,
    default: [],
  })
  excludedWeekdays!: Weekday[];

  @Column({ name: 'departure_time', type: 'time' })
  departureTime!: string;

  @Column({ name: 'return_enabled', type: 'boolean', default: false })
  returnEnabled!: boolean;

  @Column({ name: 'return_departure_time', type: 'time', nullable: true })
  returnDepartureTime!: string | null;

  @Column({ name: 'total_seats', type: 'int' })
  totalSeats!: number;

  @Column({ name: 'price_per_seat', type: 'bigint' })
  pricePerSeat!: string;

  @Column({ name: 'max_two_in_back_seat', type: 'boolean', default: false })
  maxTwoInBackSeat!: boolean;

  @Column({ name: 'no_smoking', type: 'boolean', default: false })
  noSmoking!: boolean;

  @Column({ name: 'no_pets', type: 'boolean', default: false })
  noPets!: boolean;

  @Column({ name: 'luggage_allowed', type: 'boolean', default: true })
  luggageAllowed!: boolean;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ name: 'outbound_route', type: 'jsonb' })
  outboundRoute!: CommuteRouteSnapshot;

  @Column({ name: 'return_route', type: 'jsonb', nullable: true })
  returnRoute!: CommuteRouteSnapshot | null;

  @Column({ name: 'original_ride_id', type: 'uuid', nullable: true })
  originalRideId!: string | null;

  @Column({
    name: 'publish_idempotency_key',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  publishIdempotencyKey!: string | null;

  @Column({
    name: 'request_fingerprint',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  requestFingerprint!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
