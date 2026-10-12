import { randomUUID } from 'crypto';
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { CorporateIdentityStatus } from '../enums/corporate-identity-status.enum';

@Entity('corporate_identity_verifications')
@Index('UQ_corporate_identity_verifications_user_id', ['userId'], {
  unique: true,
})
export class CorporateIdentityVerification {
  @PrimaryColumn('uuid')
  id!: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /**
   * Currently verified corporate email. Remains set while a different
   * pending email is being verified (email change flow).
   */
  @Column({
    name: 'corporate_email',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  corporateEmail!: string | null;

  /**
   * Email awaiting OTP confirmation. Cleared on successful verify or
   * when no pending request exists.
   */
  @Column({
    name: 'pending_corporate_email',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  pendingCorporateEmail!: string | null;

  @Column({
    type: 'varchar',
    length: 32,
    default: CorporateIdentityStatus.NOT_VERIFIED,
  })
  status!: CorporateIdentityStatus;

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
