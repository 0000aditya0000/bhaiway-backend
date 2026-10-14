import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Production coupon catalog:
 * - coupons, assignments, redemptions, issuances, issuance rules, audit logs
 * - booking linkage for Assured security-fee / fare discount snapshots
 *
 * Does not alter Assured NEXT_ASSURED_DEPOSIT_FREE user_coupons semantics.
 * No automatic issuance rules are activated (is_active defaults false).
 */
export class CouponCatalogSystem1786589000000 implements MigrationInterface {
  name = 'CouponCatalogSystem1786589000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "coupons" (
        "id" uuid NOT NULL,
        "code" character varying(64) NOT NULL,
        "code_normalized" character varying(64) NOT NULL,
        "title" character varying(120) NOT NULL,
        "description" text,
        "benefit_type" character varying(32) NOT NULL,
        "benefit_value" bigint NOT NULL,
        "max_discount_amount" bigint,
        "min_eligible_amount" bigint,
        "ride_type_scope" character varying(32) NOT NULL,
        "charge_scope" character varying(40) NOT NULL,
        "audience" character varying(32) NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "starts_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "total_redemption_limit" integer,
        "per_user_redemption_limit" integer,
        "redeemed_count" integer NOT NULL DEFAULT 0,
        "reserved_count" integer NOT NULL DEFAULT 0,
        "created_by_admin_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coupons" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_coupons_benefit_value_nonneg"
          CHECK ("benefit_value" >= 0),
        CONSTRAINT "CHK_coupons_validity"
          CHECK ("expires_at" > "starts_at")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_coupons_code_normalized"
      ON "coupons" ("code_normalized")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_coupons_active_valid"
      ON "coupons" ("is_active", "starts_at", "expires_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "coupon_assignments" (
        "id" uuid NOT NULL,
        "coupon_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "assigned_by_admin_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coupon_assignments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_coupon_assignments_coupon_id"
          FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_coupon_assignments_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_coupon_assignments_coupon_user"
      ON "coupon_assignments" ("coupon_id", "user_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_coupon_assignments_user_id"
      ON "coupon_assignments" ("user_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "coupon_redemptions" (
        "id" uuid NOT NULL,
        "coupon_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "status" character varying(32) NOT NULL DEFAULT 'RESERVED',
        "booking_id" uuid,
        "ride_id" uuid,
        "ride_type_scope" character varying(32) NOT NULL,
        "charge_scope" character varying(40) NOT NULL,
        "benefit_type_snapshot" character varying(32) NOT NULL,
        "benefit_value_snapshot" bigint NOT NULL,
        "code_snapshot" character varying(64) NOT NULL,
        "original_amount" bigint NOT NULL,
        "discount_amount" bigint NOT NULL DEFAULT 0,
        "final_amount" bigint NOT NULL,
        "points_credited" bigint,
        "wallet_transaction_id" uuid,
        "idempotency_key" character varying(255),
        "config_snapshot" jsonb NOT NULL,
        "reserved_at" TIMESTAMP WITH TIME ZONE,
        "redeemed_at" TIMESTAMP WITH TIME ZONE,
        "released_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coupon_redemptions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_coupon_redemptions_coupon_id"
          FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_coupon_redemptions_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_coupon_redemptions_coupon_id"
      ON "coupon_redemptions" ("coupon_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_coupon_redemptions_user_id"
      ON "coupon_redemptions" ("user_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_coupon_redemptions_booking_id"
      ON "coupon_redemptions" ("booking_id")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_coupon_redemptions_idempotency"
      ON "coupon_redemptions" ("idempotency_key")
      WHERE "idempotency_key" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "coupon_issuance_rules" (
        "id" uuid NOT NULL,
        "rule_identifier" character varying(120) NOT NULL,
        "rule_version" integer NOT NULL DEFAULT 1,
        "name" character varying(160) NOT NULL,
        "description" text,
        "is_active" boolean NOT NULL DEFAULT false,
        "config" jsonb NOT NULL DEFAULT '{}',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coupon_issuance_rules" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_coupon_issuance_rules_identifier_version"
      ON "coupon_issuance_rules" ("rule_identifier", "rule_version")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "coupon_issuances" (
        "id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "coupon_id" uuid,
        "source" character varying(48) NOT NULL,
        "reason" character varying(160),
        "rule_identifier" character varying(120),
        "rule_version" integer,
        "trip_id" uuid,
        "status" character varying(32) NOT NULL DEFAULT 'PENDING',
        "benefit_snapshot" jsonb,
        "idempotency_key" character varying(255) NOT NULL,
        "failure_message" text,
        "attempt_count" integer NOT NULL DEFAULT 0,
        "issued_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coupon_issuances" PRIMARY KEY ("id"),
        CONSTRAINT "FK_coupon_issuances_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_coupon_issuances_coupon_id"
          FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_coupon_issuances_idempotency"
      ON "coupon_issuances" ("idempotency_key")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_coupon_issuances_user_id"
      ON "coupon_issuances" ("user_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_coupon_issuances_trip_id"
      ON "coupon_issuances" ("trip_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_coupon_issuances_rule"
      ON "coupon_issuances" ("rule_identifier", "rule_version")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "coupon_audit_logs" (
        "id" uuid NOT NULL,
        "coupon_id" uuid,
        "admin_id" uuid,
        "action" character varying(80) NOT NULL,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coupon_audit_logs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_coupon_audit_logs_coupon_id"
      ON "coupon_audit_logs" ("coupon_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_coupon_audit_logs_created_at"
      ON "coupon_audit_logs" ("created_at")
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "coupon_redemption_id" uuid
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "original_assured_deposit_amount" bigint
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "coupon_discount_amount" bigint
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_bookings_coupon_redemption_id"
      ON "bookings" ("coupon_redemption_id")
      WHERE "coupon_redemption_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_bookings_coupon_redemption_id"`,
    );
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "coupon_discount_amount"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "original_assured_deposit_amount"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "coupon_redemption_id"
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS "coupon_audit_logs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "coupon_issuances"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "coupon_issuance_rules"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "coupon_redemptions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "coupon_assignments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "coupons"`);
  }
}
