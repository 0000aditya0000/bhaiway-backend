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

import { User } from '../../users/entities/user.entity';
import { Vehicle } from '../../vehicles/entities/vehicle.entity';
import {
  RegularSeatsPolicy,
  RideCancellationReason,
  RideStatus,
  RideType,
} from '../enums/ride.enums';

/**
 * Published rides offered by drivers.
 * Booking/passenger fields are intentionally absent in this phase.
 *
 * Departure schedule is stored as civil date + wall-clock time (no timezone),
 * matching local departure intent without silent UTC conversion.
 *
 * price_per_seat is integer points (1 point = ₹1), stored as bigint string
 * consistent with the wallet financial layer — never floating point.
 */
@Entity('rides')
@Index('IDX_rides_driver_id', ['driverId'])
@Index('IDX_rides_vehicle_id', ['vehicleId'])
@Index('IDX_rides_departure_date', ['departureDate'])
@Index('IDX_rides_search', ['status', 'departureDate', 'departureTime'])
@Check(`"total_seats" > 0`)
@Check(`"available_seats" >= 0`)
@Check(`"available_seats" <= "total_seats"`)
@Check(`"price_per_seat" >= 0`)
export class Ride {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => User, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'driver_id' })
  driver!: User;

  @Column({
    name: 'driver_id',
    type: 'uuid',
  })
  driverId!: string;

  @ManyToOne(() => Vehicle, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'vehicle_id' })
  vehicle!: Vehicle;

  @Column({
    name: 'vehicle_id',
    type: 'uuid',
  })
  vehicleId!: string;

  @Column({
    name: 'ride_type',
    type: 'enum',
    enum: RideType,
    default: RideType.REGULAR,
  })
  rideType!: RideType;

  @Column({
    type: 'enum',
    enum: RideStatus,
    default: RideStatus.PUBLISHED,
  })
  status!: RideStatus;

  @Column({
    type: 'varchar',
    length: 255,
  })
  source!: string;

  @Column({
    type: 'varchar',
    length: 255,
  })
  destination!: string;

  @Column({
    name: 'source_latitude',
    type: 'double precision',
    nullable: true,
  })
  sourceLatitude!: number | null;

  @Column({
    name: 'source_longitude',
    type: 'double precision',
    nullable: true,
  })
  sourceLongitude!: number | null;

  @Column({
    name: 'destination_latitude',
    type: 'double precision',
    nullable: true,
  })
  destinationLatitude!: number | null;

  @Column({
    name: 'destination_longitude',
    type: 'double precision',
    nullable: true,
  })
  destinationLongitude!: number | null;

  /** Google-encoded polyline for the published driving corridor. */
  @Column({
    name: 'route_polyline',
    type: 'text',
    nullable: true,
  })
  routePolyline!: string | null;

  @Column({
    name: 'route_length_meters',
    type: 'double precision',
    nullable: true,
  })
  routeLengthMeters!: number | null;

  @Column({
    name: 'route_bbox_min_lat',
    type: 'double precision',
    nullable: true,
  })
  routeBboxMinLat!: number | null;

  @Column({
    name: 'route_bbox_max_lat',
    type: 'double precision',
    nullable: true,
  })
  routeBboxMaxLat!: number | null;

  @Column({
    name: 'route_bbox_min_lng',
    type: 'double precision',
    nullable: true,
  })
  routeBboxMinLng!: number | null;

  @Column({
    name: 'route_bbox_max_lng',
    type: 'double precision',
    nullable: true,
  })
  routeBboxMaxLng!: number | null;

  /** Civil calendar date (YYYY-MM-DD), no timezone. */
  @Column({
    name: 'departure_date',
    type: 'date',
  })
  departureDate!: string;

  /** Local wall-clock time (HH:mm[:ss]), no timezone. */
  @Column({
    name: 'departure_time',
    type: 'time',
  })
  departureTime!: string;

  @Column({
    name: 'total_seats',
    type: 'int',
  })
  totalSeats!: number;

  @Column({
    name: 'available_seats',
    type: 'int',
  })
  availableSeats!: number;

  /** Integer points (1 point = ₹1). TypeORM bigint maps to string. */
  @Column({
    name: 'price_per_seat',
    type: 'bigint',
  })
  pricePerSeat!: string;

  @Column({
    name: 'max_two_in_back_seat',
    type: 'boolean',
    default: false,
  })
  maxTwoInBackSeat!: boolean;

  @Column({
    name: 'no_smoking',
    type: 'boolean',
    default: false,
  })
  noSmoking!: boolean;

  @Column({
    name: 'no_pets',
    type: 'boolean',
    default: false,
  })
  noPets!: boolean;

  @Column({
    name: 'luggage_allowed',
    type: 'boolean',
    default: true,
  })
  luggageAllowed!: boolean;

  @Column({
    type: 'text',
    nullable: true,
  })
  notes!: string | null;

  /**
   * Snapshot of admin deposit % used when this Assured ride was published.
   * Null for Regular rides.
   */
  @Column({
    name: 'assured_deposit_percentage',
    type: 'int',
    nullable: true,
  })
  assuredDepositPercentage!: number | null;

  /** Driver Assured deposit amount in points at publish time. */
  @Column({
    name: 'assured_deposit_amount',
    type: 'bigint',
    nullable: true,
  })
  assuredDepositAmount!: string | null;

  @Column({
    name: 'driver_deposit_hold_id',
    type: 'uuid',
    nullable: true,
  })
  driverDepositHoldId!: string | null;

  /**
   * Half-time decision for remaining Assured seats.
   * Null until decided; effective default is KEEP_ASSURED_ONLY.
   */
  @Column({
    name: 'regular_seats_policy',
    type: 'enum',
    enum: RegularSeatsPolicy,
    nullable: true,
  })
  regularSeatsPolicy!: RegularSeatsPolicy | null;

  @Column({
    name: 'regular_seats_decided_at',
    type: 'timestamptz',
    nullable: true,
  })
  regularSeatsDecidedAt!: Date | null;

  @Column({
    name: 'cancelled_at',
    type: 'timestamptz',
    nullable: true,
  })
  cancelledAt!: Date | null;

  @Column({
    name: 'cancellation_reason',
    type: 'enum',
    enum: RideCancellationReason,
    nullable: true,
  })
  cancellationReason!: RideCancellationReason | null;

  @Column({
    name: 'cancelled_by_user_id',
    type: 'uuid',
    nullable: true,
  })
  cancelledByUserId!: string | null;

  /** Seats already paid via platform partial-fill (lifetime cap 2). */
  @Column({
    name: 'partial_fill_compensated_seats',
    type: 'int',
    default: 0,
  })
  partialFillCompensatedSeats!: number;

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
