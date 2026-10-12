import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enforces at most one active Assured Ride per driver.
 * Active = ASSURANCE_PENDING | ASSURANCE_ACTIVE | IN_PROGRESS.
 *
 * Aborts if existing duplicates are found (no automatic data deletion).
 */
export class OneActiveAssuredRidePerDriver1786588000000
  implements MigrationInterface
{
  name = 'OneActiveAssuredRidePerDriver1786588000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const duplicates = await queryRunner.query(`
      SELECT driver_id::text AS "driverId",
             COUNT(*)::int AS n,
             array_agg(id::text) AS "rideIds"
      FROM rides
      WHERE ride_type = 'ASSURED'
        AND status IN ('ASSURANCE_PENDING', 'ASSURANCE_ACTIVE', 'IN_PROGRESS')
      GROUP BY driver_id
      HAVING COUNT(*) > 1
    `);

    if (Array.isArray(duplicates) && duplicates.length > 0) {
      throw new Error(
        `Cannot create UQ_rides_one_active_assured_per_driver: ` +
          `found ${duplicates.length} driver(s) with multiple active Assured rides. ` +
          `Resolve manually before migrating. Sample: ${JSON.stringify(duplicates.slice(0, 5))}`,
      );
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_rides_one_active_assured_per_driver"
      ON "rides" ("driver_id")
      WHERE "ride_type" = 'ASSURED'
        AND "status" IN ('ASSURANCE_PENDING', 'ASSURANCE_ACTIVE', 'IN_PROGRESS')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_rides_one_active_assured_per_driver"`,
    );
  }
}
