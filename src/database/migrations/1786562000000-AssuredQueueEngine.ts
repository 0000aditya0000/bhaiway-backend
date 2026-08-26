import { MigrationInterface, QueryRunner } from 'typeorm';

import { calculateAssuredQueueIdentity } from '../../assured/assured-queue-key';
import { RideStatus, RideType } from '../../rides/enums/ride.enums';

interface LegacyAssuredRideRow {
  id: string;
  source: string;
  destination: string;
  source_latitude: number | null;
  source_longitude: number | null;
  destination_latitude: number | null;
  destination_longitude: number | null;
  departure_date: string;
  departure_time: string;
  created_at: Date;
  assured_queue_key: string | null;
}

/**
 * Assured Queue Engine:
 * - ASSURANCE_PENDING / ASSURANCE_ACTIVE statuses
 * - queue key + assurance window columns
 * - partial unique index: one bookable ACTIVE offer per queue
 * - backfill existing Assured PUBLISHED rides with FIFO ACTIVE/PENDING split
 */
export class AssuredQueueEngine1786562000000 implements MigrationInterface {
  name = 'AssuredQueueEngine1786562000000';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."rides_status_enum"
      ADD VALUE IF NOT EXISTS 'ASSURANCE_PENDING'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."rides_status_enum"
      ADD VALUE IF NOT EXISTS 'ASSURANCE_ACTIVE'
    `);

    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN "assured_queue_key" character varying(512),
      ADD COLUMN "assurance_window_start" TIME,
      ADD COLUMN "assurance_window_end" TIME
    `);

    await queryRunner.query(`
      CREATE TYPE "public"."assured_queue_events_event_type_enum" AS ENUM(
        'ENQUEUED',
        'PROMOTED',
        'FULL_PROMOTION',
        'FORCE_PUBLISHED',
        'CANCELLED_PROMOTION'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."assured_queue_events_advance_reason_enum" AS ENUM(
        'FULL',
        'DRIVER_CANCELLED',
        'DRIVER_NO_SHOW',
        'FORCE_PUBLISH'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "assured_queue_events" (
        "id" uuid NOT NULL,
        "queue_key" character varying(512) NOT NULL,
        "event_type" "public"."assured_queue_events_event_type_enum" NOT NULL,
        "advance_reason" "public"."assured_queue_events_advance_reason_enum",
        "source_ride_id" uuid,
        "promoted_ride_id" uuid,
        "idempotency_key" character varying(255) NOT NULL,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_assured_queue_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_assured_queue_events_idempotency_key"
      ON "assured_queue_events" ("idempotency_key")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_assured_queue_events_queue_key"
      ON "assured_queue_events" ("queue_key")
    `);

    await this.backfillExistingAssuredRides(queryRunner);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_rides_assured_active_bookable_queue"
      ON "rides" ("assured_queue_key")
      WHERE "ride_type" = 'ASSURED'
        AND "status" = 'ASSURANCE_ACTIVE'
        AND "available_seats" > 0
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_rides_assured_queue"
      ON "rides" ("assured_queue_key", "status")
      WHERE "ride_type" = 'ASSURED'
    `);
  }

  private async backfillExistingAssuredRides(
    queryRunner: QueryRunner,
  ): Promise<void> {
    const rows: LegacyAssuredRideRow[] = await queryRunner.query(`
      SELECT
        id,
        source,
        destination,
        source_latitude,
        source_longitude,
        destination_latitude,
        destination_longitude,
        departure_date::text AS departure_date,
        departure_time::text AS departure_time,
        created_at,
        assured_queue_key
      FROM "rides"
      WHERE "ride_type" = 'ASSURED'
        AND "status" = 'PUBLISHED'
      ORDER BY "created_at" ASC, "id" ASC
    `);

    const activeByQueue = new Set<string>();

    for (const row of rows) {
      const identity = calculateAssuredQueueIdentity({
        source: row.source,
        destination: row.destination,
        sourceLatitude: row.source_latitude,
        sourceLongitude: row.source_longitude,
        destinationLatitude: row.destination_latitude,
        destinationLongitude: row.destination_longitude,
        departureDate: row.departure_date,
        departureTime: row.departure_time,
      });

      const hasActive = activeByQueue.has(identity.queueKey);
      const status = hasActive
        ? RideStatus.ASSURANCE_PENDING
        : RideStatus.ASSURANCE_ACTIVE;

      if (!hasActive) {
        activeByQueue.add(identity.queueKey);
      }

      await queryRunner.query(
        `
        UPDATE "rides"
        SET
          "status" = $1,
          "assured_queue_key" = $2,
          "assurance_window_start" = $3,
          "assurance_window_end" = $4
        WHERE "id" = $5
      `,
        [
          status,
          identity.queueKey,
          identity.assuranceWindowStart,
          identity.assuranceWindowEnd,
          row.id,
        ],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "rides"
      SET "status" = 'PUBLISHED'
      WHERE "ride_type" = 'ASSURED'
        AND "status" IN ('ASSURANCE_PENDING', 'ASSURANCE_ACTIVE')
    `);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_rides_assured_queue"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_rides_assured_active_bookable_queue"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_assured_queue_events_queue_key"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_assured_queue_events_idempotency_key"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "assured_queue_events"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."assured_queue_events_advance_reason_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."assured_queue_events_event_type_enum"`,
    );

    await queryRunner.query(`
      ALTER TABLE "rides"
      DROP COLUMN IF EXISTS "assurance_window_end",
      DROP COLUMN IF EXISTS "assurance_window_start",
      DROP COLUMN IF EXISTS "assured_queue_key"
    `);
  }
}
