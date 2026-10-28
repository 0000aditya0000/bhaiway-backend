import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Daily Office Commute recurring series + occurrence linkage.
 *
 * Existing Regular, Assured, and single-date Commute rides keep null series
 * fields. This migration does not rewrite historical rides into series.
 *
 * Rollback drops series metadata and occurrence-linkage columns. It does not
 * delete ride or booking rows. Series audit data is lost on down().
 */
export class CommuteRideSeries1786599000000 implements MigrationInterface {
  name = 'CommuteRideSeries1786599000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."ride_series_status_enum" AS ENUM(
        'ACTIVE',
        'CANCELLED'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."ride_series_weekday_enum" AS ENUM(
        'MONDAY',
        'TUESDAY',
        'WEDNESDAY',
        'THURSDAY',
        'FRIDAY',
        'SATURDAY',
        'SUNDAY'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."rides_direction_enum" AS ENUM(
        'OUTBOUND',
        'RETURN'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "ride_series" (
        "id" uuid NOT NULL,
        "driver_id" uuid NOT NULL,
        "vehicle_id" uuid NOT NULL,
        "ride_type" "public"."rides_ride_type_enum" NOT NULL DEFAULT 'COMMUTE',
        "status" "public"."ride_series_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "publishing_date" date NOT NULL,
        "start_date" date NOT NULL,
        "end_date" date NOT NULL,
        "excluded_weekdays" "public"."ride_series_weekday_enum"[] NOT NULL DEFAULT '{}',
        "departure_time" TIME NOT NULL,
        "return_enabled" boolean NOT NULL DEFAULT false,
        "return_departure_time" TIME,
        "total_seats" integer NOT NULL,
        "price_per_seat" bigint NOT NULL,
        "max_two_in_back_seat" boolean NOT NULL DEFAULT false,
        "no_smoking" boolean NOT NULL DEFAULT false,
        "no_pets" boolean NOT NULL DEFAULT false,
        "luggage_allowed" boolean NOT NULL DEFAULT true,
        "notes" text,
        "outbound_route" jsonb NOT NULL,
        "return_route" jsonb,
        "original_ride_id" uuid,
        "publish_idempotency_key" character varying(255),
        "request_fingerprint" character varying(64),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ride_series" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ride_series_driver_id" FOREIGN KEY ("driver_id")
          REFERENCES "users"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_ride_series_vehicle_id" FOREIGN KEY ("vehicle_id")
          REFERENCES "vehicles"("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_ride_series_driver_id"
      ON "ride_series" ("driver_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_ride_series_publish_idempotency_key"
      ON "ride_series" ("publish_idempotency_key")
      WHERE "publish_idempotency_key" IS NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN "series_id" uuid,
      ADD COLUMN "occurrence_date" date,
      ADD COLUMN "direction" "public"."rides_direction_enum"
    `);

    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD CONSTRAINT "FK_rides_series_id"
      FOREIGN KEY ("series_id") REFERENCES "ride_series"("id")
      ON DELETE SET NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_rides_series_id"
      ON "rides" ("series_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_rides_series_occurrence_direction"
      ON "rides" ("series_id", "occurrence_date", "direction")
      WHERE "series_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_rides_commute_driver_slot"
      ON "rides" ("driver_id", "departure_date", "departure_time")
      WHERE "ride_type" = 'COMMUTE'
        AND "status" NOT IN ('CANCELLED', 'COMPLETED')
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_rides_commute_vehicle_slot"
      ON "rides" ("vehicle_id", "departure_date", "departure_time")
      WHERE "ride_type" = 'COMMUTE'
        AND "status" NOT IN ('CANCELLED', 'COMPLETED')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_rides_commute_vehicle_slot"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_rides_commute_driver_slot"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_rides_series_occurrence_direction"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_rides_series_id"`,
    );
    await queryRunner.query(`
      ALTER TABLE "rides" DROP CONSTRAINT IF EXISTS "FK_rides_series_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
      DROP COLUMN IF EXISTS "direction",
      DROP COLUMN IF EXISTS "occurrence_date",
      DROP COLUMN IF EXISTS "series_id"
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_ride_series_publish_idempotency_key"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_ride_series_driver_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "ride_series"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."rides_direction_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."ride_series_weekday_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."ride_series_status_enum"`,
    );
  }
}
