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
  VehicleOwnerMatchStatus,
  VehicleRcVerificationStatus,
} from '../enums/vehicle-rc-verification.enums';

@Entity('vehicle_rc_verifications')
@Index('IDX_vehicle_rc_verifications_vehicle_id', ['vehicleId'])
@Index('IDX_vehicle_rc_verifications_user_id', ['userId'])
@Index('IDX_vehicle_rc_verifications_requested_number', ['requestedVehicleNumber'])
@Index('IDX_vehicle_rc_verifications_reference_id', ['referenceId'])
@Index('IDX_vehicle_rc_verifications_status', ['status'])
export class VehicleRcVerification {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => Vehicle, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vehicle_id' })
  vehicle!: Vehicle;

  @Column({
    name: 'vehicle_id',
    type: 'uuid',
  })
  vehicleId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({
    name: 'user_id',
    type: 'uuid',
  })
  userId!: string;

  @Column({
    type: 'varchar',
    length: 50,
    default: 'CASHFREE',
  })
  provider!: string;

  @Index('UQ_vehicle_rc_verifications_verification_id', { unique: true })
  @Column({
    name: 'verification_id',
    type: 'varchar',
    length: 100,
    unique: true,
  })
  verificationId!: string;

  @Column({
    name: 'reference_id',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  referenceId!: string | null;

  @Column({
    name: 'requested_vehicle_number',
    type: 'varchar',
    length: 50,
  })
  requestedVehicleNumber!: string;

  @Column({
    name: 'verified_vehicle_number',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  verifiedVehicleNumber!: string | null;

  @Column({
    type: 'enum',
    enum: VehicleRcVerificationStatus,
    default: VehicleRcVerificationStatus.PENDING,
  })
  status!: VehicleRcVerificationStatus;

  @Column({
    name: 'rc_status',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  rcStatus!: string | null;

  @Column({
    name: 'owner_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  ownerName!: string | null;

  @Column({
    name: 'owner_count',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  ownerCount!: string | null;

  @Column({
    name: 'vehicle_class',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  vehicleClass!: string | null;

  @Column({
    name: 'manufacturer_name',
    type: 'varchar',
    length: 150,
    nullable: true,
  })
  manufacturerName!: string | null;

  @Column({
    type: 'varchar',
    length: 150,
    nullable: true,
  })
  model!: string | null;

  @Column({
    name: 'vehicle_color',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  vehicleColor!: string | null;

  @Column({
    name: 'fuel_type',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  fuelType!: string | null;

  @Column({
    name: 'body_type',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  bodyType!: string | null;

  @Column({
    name: 'vehicle_category',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  vehicleCategory!: string | null;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  chassis!: string | null;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  engine!: string | null;

  @Column({
    name: 'registration_date',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  registrationDate!: string | null;

  @Column({
    name: 'manufacturing_month_year',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  manufacturingMonthYear!: string | null;

  @Column({
    name: 'rc_expiry_date',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  rcExpiryDate!: string | null;

  @Column({
    name: 'insurance_company',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  insuranceCompany!: string | null;

  @Column({
    name: 'insurance_valid_until',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  insuranceValidUntil!: string | null;

  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  financer!: string | null;

  @Column({
    name: 'is_commercial',
    type: 'boolean',
    nullable: true,
  })
  isCommercial!: boolean | null;

  @Column({
    name: 'seat_capacity',
    type: 'int',
    nullable: true,
  })
  seatCapacity!: number | null;

  @Column({
    name: 'pucc_number',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  puccNumber!: string | null;

  @Column({
    name: 'pucc_valid_until',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  puccValidUntil!: string | null;

  @Column({
    name: 'blacklist_status',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  blacklistStatus!: string | null;

  @Column({
    name: 'owner_match_status',
    type: 'varchar',
    length: 50,
    default: VehicleOwnerMatchStatus.NOT_CHECKED,
  })
  ownerMatchStatus!: VehicleOwnerMatchStatus;

  @Column({
    name: 'failure_code',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  failureCode!: string | null;

  @Column({
    name: 'failure_reason',
    type: 'text',
    nullable: true,
  })
  failureReason!: string | null;

  @Column({
    name: 'raw_response',
    type: 'jsonb',
    nullable: true,
  })
  rawResponse!: Record<string, any> | null;

  @Column({
    name: 'verified_at',
    type: 'timestamptz',
    nullable: true,
  })
  verifiedAt!: Date | null;

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
