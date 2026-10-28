import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Driver-selected route metadata. Existing polyline/bbox columns remain the
 * geometry source of truth. route_selected_at IS NULL marks legacy rides that
 * were not explicitly selected by the driver.
 */
export class RideSelectedRoute1786597000000 implements MigrationInterface {
  name = 'RideSelectedRoute1786597000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN "route_selection_id" uuid,
      ADD COLUMN "route_selected_at" TIMESTAMPTZ,
      ADD COLUMN "route_duration_seconds" integer
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_rides_selected_route_search"
      ON "rides" ("status", "departure_date", "departure_time")
      WHERE "route_polyline" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_rides_selected_route_search"`,
    );
    await queryRunner.query(`
      ALTER TABLE "rides"
      DROP COLUMN IF EXISTS "route_duration_seconds",
      DROP COLUMN IF EXISTS "route_selected_at",
      DROP COLUMN IF EXISTS "route_selection_id"
    `);
  }
}
