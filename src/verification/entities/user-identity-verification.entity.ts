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
import { IdentityVerificationStatus } from '../enums/identity-verification.enums';

@Entity('user_identity_verifications')
@Index('IDX_user_identity_verifications_user_id', ['userId'])
@Index('IDX_user_identity_verifications_provider_type', ['provider', 'verificationType'])
@Index('IDX_user_identity_verifications_reference_id', ['referenceId'])
@Index('IDX_user_identity_verifications_status', ['status'])
export class UserIdentityVerification {
  @PrimaryColumn('uuid')
  id!: string;

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

  @Column({
    name: 'verification_type',
    type: 'varchar',
    length: 50,
    default: 'AADHAAR',
  })
  verificationType!: string;

  @Index('UQ_user_identity_verifications_verification_id', { unique: true })
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
    type: 'enum',
    enum: IdentityVerificationStatus,
    default: IdentityVerificationStatus.INITIATED,
  })
  status!: IdentityVerificationStatus;

  @Column({
    name: 'document_type',
    type: 'varchar',
    length: 50,
    default: 'AADHAAR',
  })
  documentType!: string;

  @Column({
    name: 'verification_url',
    type: 'text',
    nullable: true,
  })
  verificationUrl!: string | null;

  @Column({
    name: 'redirect_url',
    type: 'text',
    nullable: true,
  })
  redirectUrl!: string | null;

  @Column({
    name: 'url_expires_at',
    type: 'timestamptz',
    nullable: true,
  })
  urlExpiresAt!: Date | null;

  @Column({
    name: 'verified_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  verifiedName!: string | null;

  @Column({
    name: 'verified_gender',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  verifiedGender!: string | null;

  @Column({
    name: 'verified_dob',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  verifiedDob!: string | null;

  @Column({
    name: 'masked_aadhaar',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  maskedAadhaar!: string | null;

  @Column({
    name: 'aadhaar_last4',
    type: 'varchar',
    length: 4,
    nullable: true,
  })
  aadhaarLast4!: string | null;

  @Column({
    name: 'verified_mobile',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  verifiedMobile!: string | null;

  @Column({
    name: 'document_status',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  documentStatus!: string | null;

  @Column({
    name: 'document_consent',
    type: 'boolean',
    nullable: true,
  })
  documentConsent!: boolean | null;

  @Column({
    name: 'consent_valid_until',
    type: 'timestamptz',
    nullable: true,
  })
  consentValidUntil!: Date | null;

  @Column({
    name: 'failure_reason',
    type: 'text',
    nullable: true,
  })
  failureReason!: string | null;

  @Column({
    name: 'raw_status',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  rawStatus!: string | null;

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
