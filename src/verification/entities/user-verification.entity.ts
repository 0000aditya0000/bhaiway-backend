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
import {
  VerificationStatus,
  VerificationType,
} from '../enums/verification.enums';

/**
 * Append-only verification history per user + type.
 * Exactly one row may be current (`is_current = true`) per (user_id, verification_type).
 * Rejected/expired records are retained with is_current=false to preserve history.
 */
@Entity('user_verifications')
@Index('IDX_user_verifications_user_id', ['userId'])
@Index('UQ_user_verifications_current', ['userId', 'verificationType'], {
  unique: true,
  where: '"is_current" = true',
})
export class UserVerification {
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
    name: 'verification_type',
    type: 'enum',
    enum: VerificationType,
  })
  verificationType!: VerificationType;

  @Column({
    type: 'enum',
    enum: VerificationStatus,
    default: VerificationStatus.PENDING,
  })
  status!: VerificationStatus;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  provider!: string | null;

  @Column({
    name: 'provider_reference',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  providerReference!: string | null;

  /** Object-storage URL reference only — never store document bytes in Postgres. */
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
    name: 'is_current',
    type: 'boolean',
    default: true,
  })
  isCurrent!: boolean;

  @Column({
    name: 'submitted_at',
    type: 'timestamptz',
  })
  submittedAt!: Date;

  @Column({
    name: 'verified_at',
    type: 'timestamptz',
    nullable: true,
  })
  verifiedAt!: Date | null;

  @Column({
    name: 'rejected_at',
    type: 'timestamptz',
    nullable: true,
  })
  rejectedAt!: Date | null;

  @Column({
    name: 'rejection_reason',
    type: 'text',
    nullable: true,
  })
  rejectionReason!: string | null;

  @Column({
    name: 'expires_at',
    type: 'timestamptz',
    nullable: true,
  })
  expiresAt!: Date | null;

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
