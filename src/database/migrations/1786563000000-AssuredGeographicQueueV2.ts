import { randomUUID } from 'crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';

import { formatGeographicQueueAuditKey } from '../../assured/assured-route-compatibility';
import {
  ASSURED_QUEUE_CORRIDOR_RADIUS_KM_KEY,
  DEFAULT_ASSURED_QUEUE_CORRIDOR_RADIUS_KM,
} from '../../settings/entities/app-setting.entity';
import { buildStraightRouteGeometry } from '../../rides/route/route-geometry';

interface LegacyAssuredRideRow {
  id: string;
  assured_queue_key: string;
  departure_date: string;
  assurance_window_start: string | null;
  assurance_window_end: string | null;
  source_latitude: number | null;
  source_longitude: number | null;
  destination_latitude: number | null;
  destination_longitude: number | null;
  route_polyline: string | null;
  created_at: Date;
}

/**
 * Assured Geographic Queue Engine V2:
 * - assured_geographic_queues table with snapshotted corridor radius
 * - rides.assured_queue_id authoritative membership
 * - partial unique index retargeted to assured_queue_id
 * - conservative V1 backfill: one geographic queue per legacy assured_queue_key
 */
export class AssuredGeographicQueueV21786563000000
  implements MigrationInterface
{
  name = 'AssuredGeographicQueueV21786563000000';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "assured_geographic_queues" (
        "id" uuid NOT NULL,
        "departure_date" date NOT NULL,
        "assurance_window_start" TIME NOT NULL,
        "assurance_window_end" TIME NOT NULL,
        "canonical_polyline" text NOT NULL,
        "anchor_source_latitude" double precision NOT NULL,
        "anchor_source_longitude" double precision NOT NULL,
        "anchor_destination_latitude" double precision NOT NULL,
        "anchor_destination_longitude" double precision NOT NULL,
        "corridor_radius_meters" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_assured_geographic_queues" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_assured_geo_queues_lookup"
      ON "assured_geographic_queues" (
        "departure_date",
        "assurance_window_start",
        "assurance_window_end"
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_assured_geo_queues_dest_prefilter"
      ON "assured_geographic_queues" (
        "departure_date",
        "assurance_window_start",
        "assurance_window_end",
        "anchor_destination_latitude",
        "anchor_destination_longitude"
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN "assured_queue_id" uuid
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_rides_assured_queue_id"
      ON "rides" ("assured_queue_id", "status")
      WHERE "ride_type" = 'ASSURED'
    `);

    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD CONSTRAINT "FK_rides_assured_queue_id"
      FOREIGN KEY ("assured_queue_id")
      REFERENCES "assured_geographic_queues"("id")
      ON DELETE SET NULL
      ON UPDATE NO ACTION
    `);

    const corridorRadiusMeters = await this.resolveDefaultCorridorRadiusMeters(
      queryRunner,
    );
    await this.backfillGeographicQueues(queryRunner, corridorRadiusMeters);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."UQ_rides_assured_active_bookable_queue"
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_rides_assured_active_bookable_queue"
      ON "rides" ("assured_queue_id")
      WHERE "ride_type" = 'ASSURED'
        AND "status" = 'ASSURANCE_ACTIVE'
        AND "available_seats" > 0
    `);
  }

  private async resolveDefaultCorridorRadiusMeters(
    queryRunner: QueryRunner,
  ): Promise<number> {
    const rows: Array<{ value: string }> = await queryRunner.query(
      `SELECT value FROM app_settings WHERE key = $1 LIMIT 1`,
      [ASSURED_QUEUE_CORRIDOR_RADIUS_KM_KEY],
    );
    const km =
      rows.length > 0
        ? Number(rows[0].value)
        : DEFAULT_ASSURED_QUEUE_CORRIDOR_RADIUS_KM;
    const validKm =
      Number.isInteger(km) && km >= 5 && km <= 200
        ? km
        : DEFAULT_ASSURED_QUEUE_CORRIDOR_RADIUS_KM;
    return validKm * 1000;
  }

  private async backfillGeographicQueues(
    queryRunner: QueryRunner,
    corridorRadiusMeters: number,
  ): Promise<void> {
    const queueKeys: Array<{ assured_queue_key: string }> =
      await queryRunner.query(`
        SELECT DISTINCT assured_queue_key
        FROM rides
        WHERE ride_type = 'ASSURED'
          AND assured_queue_key IS NOT NULL
        ORDER BY assured_queue_key ASC
      `);

    for (const { assured_queue_key: queueKey } of queueKeys) {
      const rides: LegacyAssuredRideRow[] = await queryRunner.query(
        `
        SELECT
          id,
          assured_queue_key,
          departure_date::text AS departure_date,
          assurance_window_start::text AS assurance_window_start,
          assurance_window_end::text AS assurance_window_end,
          source_latitude,
          source_longitude,
          destination_latitude,
          destination_longitude,
          route_polyline,
          created_at
        FROM rides
        WHERE ride_type = 'ASSURED'
          AND assured_queue_key = $1
        ORDER BY created_at ASC, id ASC
      `,
        [queueKey],
      );

      if (rides.length === 0) {
        continue;
      }

      const seed =
        rides.find(
          (row) =>
            row.route_polyline &&
            row.source_latitude != null &&
            row.source_longitude != null &&
            row.destination_latitude != null &&
            row.destination_longitude != null,
        ) ?? rides[0];

      if (
        seed.source_latitude == null ||
        seed.source_longitude == null ||
        seed.destination_latitude == null ||
        seed.destination_longitude == null ||
        !seed.assurance_window_start ||
        !seed.assurance_window_end
      ) {
        continue;
      }

      let polyline = seed.route_polyline;
      if (!polyline) {
        const built = buildStraightRouteGeometry(
          {
            latitude: seed.source_latitude,
            longitude: seed.source_longitude,
          },
          {
            latitude: seed.destination_latitude,
            longitude: seed.destination_longitude,
          },
        );
        polyline = built.polylineEncoded;
      }

      const queueId = randomUUID();
      await queryRunner.query(
        `
        INSERT INTO assured_geographic_queues (
          id,
          departure_date,
          assurance_window_start,
          assurance_window_end,
          canonical_polyline,
          anchor_source_latitude,
          anchor_source_longitude,
          anchor_destination_latitude,
          anchor_destination_longitude,
          corridor_radius_meters
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
        [
          queueId,
          seed.departure_date,
          seed.assurance_window_start,
          seed.assurance_window_end,
          polyline,
          seed.source_latitude,
          seed.source_longitude,
          seed.destination_latitude,
          seed.destination_longitude,
          corridorRadiusMeters,
        ],
      );

      const auditKey = formatGeographicQueueAuditKey(queueId);
      await queryRunner.query(
        `
        UPDATE rides
        SET
          assured_queue_id = $1,
          assured_queue_key = $2
        WHERE ride_type = 'ASSURED'
          AND assured_queue_key = $3
      `,
        [queueId, auditKey, queueKey],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."UQ_rides_assured_active_bookable_queue"
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_rides_assured_active_bookable_queue"
      ON "rides" ("assured_queue_key")
      WHERE "ride_type" = 'ASSURED'
        AND "status" = 'ASSURANCE_ACTIVE'
        AND "available_seats" > 0
    `);

    await queryRunner.query(`
      ALTER TABLE "rides"
      DROP CONSTRAINT IF EXISTS "FK_rides_assured_queue_id"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."IDX_rides_assured_queue_id"
    `);

    await queryRunner.query(`
      ALTER TABLE "rides"
      DROP COLUMN IF EXISTS "assured_queue_id"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."IDX_assured_geo_queues_dest_prefilter"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."IDX_assured_geo_queues_lookup"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "assured_geographic_queues"`);
  }
}
