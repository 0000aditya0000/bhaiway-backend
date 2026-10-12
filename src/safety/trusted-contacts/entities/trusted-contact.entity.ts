import { randomUUID } from 'crypto';
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

import { User } from '../../../users/entities/user.entity';
import { TrustedContactRelationship } from '../enums/trusted-contact-relationship.enum';

/**
 * Private Safety Hub contact owned by a BhaiWay user.
 * Soft-deleted rows are retained for future SOS / emergency references.
 */
@Entity('trusted_contacts')
@Index('IDX_trusted_contacts_user_id', ['userId'])
@Index('UQ_trusted_contacts_user_phone_active', ['userId', 'phoneNumber'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
export class TrustedContact {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  /** BhaiWay account owner — never the contact's own account id. */
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  /** Normalized `+91XXXXXXXXXX`. */
  @Column({ name: 'phone_number', type: 'varchar', length: 20 })
  phoneNumber!: string;

  @Column({
    type: 'varchar',
    length: 32,
  })
  relationship!: TrustedContactRelationship;

  /**
   * Optional photo URL / storage reference (same pattern as UserProfile.profilePhoto).
   * No dedicated upload pipeline exists yet — clients may supply a supported URL.
   */
  @Column({ name: 'photo_url', type: 'text', nullable: true })
  photoUrl!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
