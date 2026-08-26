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

@Entity('assured_geographic_queues')
@Index('IDX_assured_geo_queues_lookup', [
  'departureDate',
  'assuranceWindowStart',
  'assuranceWindowEnd',
])
@Index('IDX_assured_geo_queues_dest_prefilter', [
  'departureDate',
  'assuranceWindowStart',
  'assuranceWindowEnd',
  'anchorDestinationLatitude',
  'anchorDestinationLongitude',
])
export class AssuredGeographicQueue {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'departure_date', type: 'date' })
  departureDate!: string;

  @Column({ name: 'assurance_window_start', type: 'time' })
  assuranceWindowStart!: string;

  @Column({ name: 'assurance_window_end', type: 'time' })
  assuranceWindowEnd!: string;

  @Column({ name: 'canonical_polyline', type: 'text' })
  canonicalPolyline!: string;

  @Column({ name: 'anchor_source_latitude', type: 'double precision' })
  anchorSourceLatitude!: number;

  @Column({ name: 'anchor_source_longitude', type: 'double precision' })
  anchorSourceLongitude!: number;

  @Column({ name: 'anchor_destination_latitude', type: 'double precision' })
  anchorDestinationLatitude!: number;

  @Column({ name: 'anchor_destination_longitude', type: 'double precision' })
  anchorDestinationLongitude!: number;

  /** Snapshotted at queue creation; admin changes do not retroactively affect this queue. */
  @Column({ name: 'corridor_radius_meters', type: 'int' })
  corridorRadiusMeters!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  generateId() {
    this.id ??= randomUUID();
  }
}
