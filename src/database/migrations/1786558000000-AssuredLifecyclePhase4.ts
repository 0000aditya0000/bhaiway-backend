import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Assured Ride Phase 4 — cancellation, no-show, partial-fill, half-time,
 * coupons, platform wallet, lifecycle events.
 */
export class AssuredLifecyclePhase41786558000000
  implements MigrationInterface
{
  name = 'AssuredLifecyclePhase41786558000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- Wallet ledger enum extensions ---
    await queryRunner.query(`
      ALTER TYPE "public"."wallet_transactions_transaction_type_enum"
      ADD VALUE IF NOT EXISTS 'ASSURED_RIDER_COMPENSATION'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."wallet_transactions_transaction_type_enum"
      ADD VALUE IF NOT EXISTS 'ASSURED_PARTIAL_FILL_COMPENSATION'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."wallet_transactions_transaction_type_enum"
      ADD VALUE IF NOT EXISTS 'ASSURED_PLATFORM_FORFEITURE'
    `);

    // --- Ride Assured lifecycle columns ---
    await queryRunner.query(`
      CREATE TYPE "public"."rides_regular_seats_policy_enum" AS ENUM(
        'KEEP_ASSURED_ONLY',
        'ALLOW_REGULAR_RIDERS'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."rides_cancellation_reason_enum" AS ENUM(
        'DRIVER_CANCELLED',
        'DRIVER_NO_SHOW'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD "regular_seats_policy" "public"."rides_regular_seats_policy_enum"
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD "regular_seats_decided_at" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD "cancelled_at" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD "cancellation_reason" "public"."rides_cancellation_reason_enum"
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD "cancelled_by_user_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD "partial_fill_compensated_seats" integer NOT NULL DEFAULT 0
    `);

    // --- Booking Assured lifecycle columns ---
    await queryRunner.query(`
      CREATE TYPE "public"."bookings_booking_mode_enum" AS ENUM(
        'ASSURED',
        'REGULAR'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."bookings_cancellation_reason_enum" AS ENUM(
        'RIDER_CANCELLED',
        'RIDER_NO_SHOW',
        'RIDE_CANCELLED',
        'DRIVER_NO_SHOW'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD "booking_mode" "public"."bookings_booking_mode_enum"
    `);
    await queryRunner.query(`
      UPDATE "bookings" b
      SET "booking_mode" = CASE
        WHEN r."ride_type" = 'ASSURED' AND b."payment_method" = 'ASSURED_DEPOSIT'
          THEN 'ASSURED'::"public"."bookings_booking_mode_enum"
        ELSE 'REGULAR'::"public"."bookings_booking_mode_enum"
      END
      FROM "rides" r
      WHERE r."id" = b."ride_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ALTER COLUMN "booking_mode" SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ALTER COLUMN "booking_mode" SET DEFAULT 'REGULAR'
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD "cancelled_at" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD "cancellation_reason" "public"."bookings_cancellation_reason_enum"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD "deposit_coupon_id" uuid
    `);

    // --- Coupons ---
    await queryRunner.query(`
      CREATE TYPE "public"."user_coupons_coupon_type_enum" AS ENUM(
        'NEXT_ASSURED_DEPOSIT_FREE'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."user_coupons_status_enum" AS ENUM(
        'UNUSED',
        'USED'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "user_coupons" (
        "id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "coupon_type" "public"."user_coupons_coupon_type_enum" NOT NULL,
        "status" "public"."user_coupons_status_enum" NOT NULL DEFAULT 'UNUSED',
        "source_reference_type" character varying(50) NOT NULL,
        "source_reference_id" character varying(255) NOT NULL,
        "used_at" TIMESTAMP WITH TIME ZONE,
        "used_booking_id" uuid,
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_coupons_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_user_coupons_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_user_coupons_user_id" ON "user_coupons" ("user_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_user_coupons_source"
      ON "user_coupons" ("source_reference_type", "source_reference_id")
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD CONSTRAINT "FK_bookings_deposit_coupon_id"
      FOREIGN KEY ("deposit_coupon_id") REFERENCES "user_coupons"("id")
      ON DELETE SET NULL
    `);

    // --- Lifecycle events (idempotent business events) ---
    await queryRunner.query(`
      CREATE TYPE "public"."assured_lifecycle_events_event_type_enum" AS ENUM(
        'DRIVER_CANCEL',
        'RIDER_CANCEL',
        'DRIVER_NO_SHOW',
        'RIDER_NO_SHOW',
        'PARTIAL_FILL_COMPENSATION',
        'HALF_TIME_DECISION'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "assured_lifecycle_events" (
        "id" uuid NOT NULL,
        "event_type" "public"."assured_lifecycle_events_event_type_enum" NOT NULL,
        "ride_id" uuid,
        "booking_id" uuid,
        "actor_user_id" uuid,
        "idempotency_key" character varying(255) NOT NULL,
        "amount" bigint,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_assured_lifecycle_events_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_assured_lifecycle_events_idempotency_key" UNIQUE ("idempotency_key")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_assured_lifecycle_events_ride_id"
      ON "assured_lifecycle_events" ("ride_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_assured_lifecycle_events_booking_id"
      ON "assured_lifecycle_events" ("booking_id")
    `);

    // --- Platform system user + wallet ---
    // Fixed IDs for stable resolution.
    await queryRunner.query(`
      INSERT INTO "users" (
        "id", "phone", "phone_verified", "email", "email_verified",
        "status", "created_at", "updated_at"
      ) VALUES (
        '00000000-0000-4000-8000-000000000001',
        '+10000000000',
        true,
        'platform@bhaiway.internal',
        true,
        'ACTIVE',
        now(),
        now()
      )
      ON CONFLICT ("id") DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO "wallets" (
        "id", "user_id", "status", "created_at", "updated_at"
      ) VALUES (
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000001',
        'ACTIVE',
        now(),
        now()
      )
      ON CONFLICT ("id") DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO "wallet_balances" (
        "id", "wallet_id",
        "purchased_available", "promotional_available", "driver_earned_available",
        "purchased_held", "promotional_held", "driver_earned_held",
        "created_at", "updated_at"
      ) VALUES (
        '00000000-0000-4000-8000-000000000003',
        '00000000-0000-4000-8000-000000000002',
        '10000000', '0', '0',
        '0', '0', '0',
        now(),
        now()
      )
      ON CONFLICT ("wallet_id") DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO "wallet_point_lots" (
        "id", "wallet_id", "source_type",
        "original_amount", "available_amount", "held_amount",
        "expires_at", "reference_type", "reference_id",
        "created_at", "updated_at"
      ) VALUES (
        '00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000002',
        'PURCHASED',
        '10000000', '10000000', '0',
        NULL,
        'PLATFORM_SEED',
        'platform-operating-float',
        now(),
        now()
      )
      ON CONFLICT ("id") DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO "app_settings" ("key", "value")
      VALUES
        ('PLATFORM_USER_ID', '00000000-0000-4000-8000-000000000001'),
        ('PLATFORM_WALLET_ID', '00000000-0000-4000-8000-000000000002')
      ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "app_settings"
      WHERE "key" IN ('PLATFORM_USER_ID', 'PLATFORM_WALLET_ID')
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "assured_lifecycle_events"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."assured_lifecycle_events_event_type_enum"`,
    );
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "FK_bookings_deposit_coupon_id"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_coupons"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."user_coupons_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."user_coupons_coupon_type_enum"`,
    );
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "deposit_coupon_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "cancellation_reason"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "cancelled_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "booking_mode"
    `);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."bookings_cancellation_reason_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."bookings_booking_mode_enum"`,
    );
    await queryRunner.query(`
      ALTER TABLE "rides" DROP COLUMN IF EXISTS "partial_fill_compensated_seats"
    `);
    await queryRunner.query(`
      ALTER TABLE "rides" DROP COLUMN IF EXISTS "cancelled_by_user_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "rides" DROP COLUMN IF EXISTS "cancellation_reason"
    `);
    await queryRunner.query(`
      ALTER TABLE "rides" DROP COLUMN IF EXISTS "cancelled_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "rides" DROP COLUMN IF EXISTS "regular_seats_decided_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "rides" DROP COLUMN IF EXISTS "regular_seats_policy"
    `);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."rides_cancellation_reason_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."rides_regular_seats_policy_enum"`,
    );
  }
}
