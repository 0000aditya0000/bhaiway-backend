import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Route-corridor search support:
 * endpoint coordinates + encoded polyline + bbox for Stage-1 filtering.
 * Nullable for backward compatibility with rides created before this change.
 */
export class RideRouteGeometry1786561000000 implements MigrationInterface {
  name = 'RideRouteGeometry1786561000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN "source_latitude" double precision,
      ADD COLUMN "source_longitude" double precision,
      ADD COLUMN "destination_latitude" double precision,
      ADD COLUMN "destination_longitude" double precision,
      ADD COLUMN "route_polyline" text,
      ADD COLUMN "route_length_meters" double precision,
      ADD COLUMN "route_bbox_min_lat" double precision,
      ADD COLUMN "route_bbox_max_lat" double precision,
      ADD COLUMN "route_bbox_min_lng" double precision,
      ADD COLUMN "route_bbox_max_lng" double precision
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_rides_route_bbox"
      ON "rides" (
        "status",
        "departure_date",
        "route_bbox_min_lat",
        "route_bbox_max_lat",
        "route_bbox_min_lng",
        "route_bbox_max_lng"
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_rides_route_bbox"`,
    );
    await queryRunner.query(`
      ALTER TABLE "rides"
      DROP COLUMN IF EXISTS "route_bbox_max_lng",
      DROP COLUMN IF EXISTS "route_bbox_min_lng",
      DROP COLUMN IF EXISTS "route_bbox_max_lat",
      DROP COLUMN IF EXISTS "route_bbox_min_lat",
      DROP COLUMN IF EXISTS "route_length_meters",
      DROP COLUMN IF EXISTS "route_polyline",
      DROP COLUMN IF EXISTS "destination_longitude",
      DROP COLUMN IF EXISTS "destination_latitude",
      DROP COLUMN IF EXISTS "source_longitude",
      DROP COLUMN IF EXISTS "source_latitude"
    `);
  }
}
