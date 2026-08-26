import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Client Idempotency-Key for Assured ride publish (double-tap / retry safety).
 * Mirrors bookings.idempotency_key semantics; Regular publishes leave this null.
 */
export class AssuredPublishIdempotency1786565000000
  implements MigrationInterface
{
  name = 'AssuredPublishIdempotency1786565000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN "publish_idempotency_key" character varying(255)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_rides_publish_idempotency_key"
      ON "rides" ("publish_idempotency_key")
      WHERE "publish_idempotency_key" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_rides_publish_idempotency_key"
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
      DROP COLUMN IF EXISTS "publish_idempotency_key"
    `);
  }
}
