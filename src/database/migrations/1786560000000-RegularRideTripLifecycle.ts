import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Regular ride trip lifecycle:
 * - rides.status IN_PROGRESS
 * - booking pickup OTP (hash + encrypted code for rider display)
 * - booking pickupStatus / pickupOrder / attempts
 *
 * Existing bookings remain valid; Regular CONFIRMED/PENDING rows get
 * WAITING_FOR_PICKUP + deterministic pickup_order. OTP material is filled
 * lazily by the application on next read/start.
 */
export class RegularRideTripLifecycle1786560000000
  implements MigrationInterface
{
  name = 'RegularRideTripLifecycle1786560000000';

  // PostgreSQL ADD VALUE cannot run inside a transaction block.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."rides_status_enum"
      ADD VALUE IF NOT EXISTS 'IN_PROGRESS'
    `);

    await queryRunner.query(`
      CREATE TYPE "public"."bookings_pickup_status_enum" AS ENUM(
        'WAITING_FOR_PICKUP',
        'PICKED_UP'
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN "pickup_otp_hash" character varying(128),
      ADD COLUMN "pickup_otp_ciphertext" text,
      ADD COLUMN "pickup_status" "public"."bookings_pickup_status_enum",
      ADD COLUMN "pickup_verified_at" TIMESTAMP WITH TIME ZONE,
      ADD COLUMN "pickup_otp_failed_attempts" integer NOT NULL DEFAULT 0,
      ADD COLUMN "pickup_otp_expires_at" TIMESTAMP WITH TIME ZONE,
      ADD COLUMN "pickup_order" integer
    `);

    await queryRunner.query(`
      UPDATE "bookings" b
      SET
        "pickup_status" = 'WAITING_FOR_PICKUP',
        "pickup_order" = ranked.ord
      FROM (
        SELECT
          bk.id,
          ROW_NUMBER() OVER (
            PARTITION BY bk.ride_id
            ORDER BY bk.created_at ASC, bk.id ASC
          )::int AS ord
        FROM "bookings" bk
        INNER JOIN "rides" r ON r.id = bk.ride_id
        WHERE r.ride_type = 'REGULAR'
          AND bk.status IN ('PENDING', 'CONFIRMED')
      ) ranked
      WHERE b.id = ranked.id
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_bookings_ride_pickup_order"
      ON "bookings" ("ride_id", "pickup_order")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_bookings_ride_pickup_order"`,
    );
    await queryRunner.query(`
      ALTER TABLE "bookings"
      DROP COLUMN IF EXISTS "pickup_order",
      DROP COLUMN IF EXISTS "pickup_otp_expires_at",
      DROP COLUMN IF EXISTS "pickup_otp_failed_attempts",
      DROP COLUMN IF EXISTS "pickup_verified_at",
      DROP COLUMN IF EXISTS "pickup_status",
      DROP COLUMN IF EXISTS "pickup_otp_ciphertext",
      DROP COLUMN IF EXISTS "pickup_otp_hash"
    `);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."bookings_pickup_status_enum"`,
    );
    // IN_PROGRESS enum value cannot be removed safely from PostgreSQL.
  }
}
