import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Assured Geographic Queue V2.1 hardening:
 * - Cancel unconstrained Assured ACTIVE/PENDING rides with NULL assured_queue_id
 * - Enforce CHECK: Assured ACTIVE/PENDING must have assured_queue_id
 */
export class AssuredGeographicQueueV21Hardening1786564000000
  implements MigrationInterface
{
  name = 'AssuredGeographicQueueV21Hardening1786564000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Bookable ACTIVE without queue membership escapes the partial unique index
    // (NULL ≠ NULL). Cancel them safely rather than inventing geographic membership.
    await queryRunner.query(`
      UPDATE "rides"
      SET
        "status" = 'CANCELLED',
        "cancellation_reason" = 'DRIVER_CANCELLED',
        "cancelled_at" = COALESCE("cancelled_at", NOW()),
        "updated_at" = NOW()
      WHERE "ride_type" = 'ASSURED'
        AND "status" IN ('ASSURANCE_ACTIVE', 'ASSURANCE_PENDING')
        AND "assured_queue_id" IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD CONSTRAINT "CHK_rides_assured_queue_membership"
      CHECK (
        "ride_type" <> 'ASSURED'
        OR "status" NOT IN ('ASSURANCE_ACTIVE', 'ASSURANCE_PENDING')
        OR "assured_queue_id" IS NOT NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
      DROP CONSTRAINT IF EXISTS "CHK_rides_assured_queue_membership"
    `);
  }
}
