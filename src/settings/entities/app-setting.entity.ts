import {
  Column,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('app_settings')
export class AppSetting {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  key!: string;

  @Column({ type: 'varchar', length: 255 })
  value!: string;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
  })
  updatedAt!: Date;
}

export const ASSURED_RIDE_DEPOSIT_PERCENTAGE_KEY =
  'ASSURED_RIDE_DEPOSIT_PERCENTAGE';

export const DEFAULT_ASSURED_RIDE_DEPOSIT_PERCENTAGE = 5;
