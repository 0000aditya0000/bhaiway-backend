import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { randomUUID } from 'crypto';

import { User } from '../../users/entities/user.entity';
import { VehicleType } from '../enums/vehicle-type.enum';

/**
 * Soft-deleted vehicles are retained for future ride history.
 * Exactly one non-deleted vehicle may be active per user (enforced in service;
 * partial unique index reinforces registration uniqueness per user).
 */
@Entity('vehicles')
@Index('IDX_vehicles_user_id', ['userId'])
@Index('UQ_vehicles_user_registration_active', ['userId', 'registrationNumber'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
export class Vehicle {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => User, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({
    name: 'user_id',
    type: 'uuid',
  })
  userId!: string;

  @Column({
    name: 'vehicle_type',
    type: 'enum',
    enum: VehicleType,
  })
  vehicleType!: VehicleType;

  @Column({
    type: 'varchar',
    length: 100,
  })
  make!: string;

  @Column({
    type: 'varchar',
    length: 100,
  })
  model!: string;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  variant!: string | null;

  @Column({
    name: 'registration_number',
    type: 'varchar',
    length: 20,
  })
  registrationNumber!: string;

  @Column({
    name: 'registration_year',
    type: 'int',
    nullable: true,
  })
  registrationYear!: number | null;

  @Column({
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  color!: string | null;

  @Column({
    name: 'seating_capacity',
    type: 'int',
  })
  seatingCapacity!: number;

  /** Object-storage reference only — never store RC document bytes. */
  @Column({
    name: 'document_url',
    type: 'text',
    nullable: true,
  })
  documentUrl!: string | null;

  @Column({
    name: 'document_type',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  documentType!: string | null;

  @Column({
    name: 'document_reference',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  documentReference!: string | null;

  @Column({
    name: 'is_active',
    type: 'boolean',
    default: false,
  })
  isActive!: boolean;

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

  @DeleteDateColumn({
    name: 'deleted_at',
    type: 'timestamptz',
    nullable: true,
  })
  deletedAt!: Date | null;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
