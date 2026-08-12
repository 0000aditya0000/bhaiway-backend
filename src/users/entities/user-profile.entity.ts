import {
    BeforeInsert,
    Column,
    CreateDateColumn,
    Entity,
    JoinColumn,
    OneToOne,
    PrimaryColumn,
    UpdateDateColumn,
  } from 'typeorm';
  import { randomUUID } from 'crypto';
  import { User } from './user.entity';
  
  export enum Gender {
    MALE = 'MALE',
    FEMALE = 'FEMALE',
    OTHER = 'OTHER',
    PREFER_NOT_TO_SAY = 'PREFER_NOT_TO_SAY',
  }
  
  @Entity('user_profiles')
  export class UserProfile {
    @PrimaryColumn('uuid')
    id!: string;
  
    @OneToOne(() => User, {
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
      name: 'first_name',
      type: 'varchar',
      length: 100,
    })
    firstName!: string;
  
    @Column({
      name: 'last_name',
      type: 'varchar',
      length: 100,
      nullable: true,
    })
    lastName!: string | null;
  
    @Column({
      name: 'display_name',
      type: 'varchar',
      length: 150,
      nullable: true,
    })
    displayName!: string | null;
  
    @Column({
      type: 'enum',
      enum: Gender,
      nullable: true,
    })
    gender!: Gender | null;
  
    @Column({
      name: 'date_of_birth',
      type: 'date',
      nullable: true,
    })
    dateOfBirth!: string | null;
  
    @Column({
      name: 'profile_photo',
      type: 'text',
      nullable: true,
    })
    profilePhoto!: string | null;
  
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