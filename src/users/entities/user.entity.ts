import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { randomUUID } from 'crypto';

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  DEACTIVATED = 'DEACTIVATED',
}

@Entity('users')
@Index('IDX_users_status', ['status'])
@Index('IDX_users_created_at', ['createdAt'])
export class User {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({
    type: 'varchar',
    length: 20,
    unique: true,
  })
  phone!: string;

  @Column({
    name: 'phone_verified',
    type: 'boolean',
    default: false,
  })
  phoneVerified!: boolean;

  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
    unique: true,
  })
  email!: string | null;

  @Column({
    name: 'email_verified',
    type: 'boolean',
    default: false,
  })
  emailVerified!: boolean;

  /**
   * Stable unique invite code (e.g. BHW7K4P9). Backend-generated; immutable for users.
   */
  @Column({
    name: 'referral_code',
    type: 'varchar',
    length: 32,
    unique: true,
    nullable: true,
  })
  referralCode!: string | null;

  @Column({
    type: 'enum',
    enum: UserStatus,
    default: UserStatus.ACTIVE,
  })
  status!: UserStatus;

  /**
   * Incremented on suspend (and force-logout). JWT payload `tv` must match.
   * Enables immediate access-token rejection without a session store.
   */
  @Column({
    name: 'token_version',
    type: 'int',
    default: 0,
  })
  tokenVersion!: number;

  /** When true, user cannot create new bookings (independent of account status). */
  @Column({
    name: 'booking_restricted',
    type: 'boolean',
    default: false,
  })
  bookingRestricted!: boolean;

  /** When true, user cannot publish new rides (independent of account status). */
  @Column({
    name: 'ride_publish_restricted',
    type: 'boolean',
    default: false,
  })
  ridePublishRestricted!: boolean;

  @Column({
    name: 'suspension_reason',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  suspensionReason!: string | null;

  @Column({
    name: 'suspended_at',
    type: 'timestamptz',
    nullable: true,
  })
  suspendedAt!: Date | null;

  @Column({
    name: 'booking_restricted_reason',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  bookingRestrictedReason!: string | null;

  @Column({
    name: 'ride_publish_restricted_reason',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  ridePublishRestrictedReason!: string | null;

  @Column({
    name: 'last_login_at',
    type: 'timestamptz',
    nullable: true,
  })
  lastLoginAt!: Date | null;

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
