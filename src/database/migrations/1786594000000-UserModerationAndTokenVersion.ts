import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admin user moderation: JWT token version for immediate revocation,
 * independent booking / ride-publish restrictions, suspension metadata.
 */
export class UserModerationAndTokenVersion1786594000000
  implements MigrationInterface
{
  name = 'UserModerationAndTokenVersion1786594000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "token_version" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "booking_restricted" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "ride_publish_restricted" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "suspension_reason" character varying(500)
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "suspended_at" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "booking_restricted_reason" character varying(500)
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "ride_publish_restricted_reason" character varying(500)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_status"
      ON "users" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_created_at"
      ON "users" ("created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_booking_restricted"
      ON "users" ("booking_restricted")
      WHERE "booking_restricted" = true
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_ride_publish_restricted"
      ON "users" ("ride_publish_restricted")
      WHERE "ride_publish_restricted" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_users_ride_publish_restricted"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_users_booking_restricted"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_status"`);

    await queryRunner.query(`
      ALTER TABLE "users"
      DROP COLUMN IF EXISTS "ride_publish_restricted_reason"
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      DROP COLUMN IF EXISTS "booking_restricted_reason"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "suspended_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "suspension_reason"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "ride_publish_restricted"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "booking_restricted"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "token_version"
    `);
  }
}
