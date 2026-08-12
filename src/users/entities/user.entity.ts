import {
    BeforeInsert,
    Column,
    CreateDateColumn,
    Entity,
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
  
    @Column({
      type: 'enum',
      enum: UserStatus,
      default: UserStatus.ACTIVE,
    })
    status!: UserStatus;
  
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