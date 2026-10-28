import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * No-Show claim workflow: pending claims with a 15-minute response window,
 * audit trail, and notification types. Does not change financial formulas.
 */
export class NoShowClaims1786595000000 implements MigrationInterface {
  name = 'NoShowClaims1786595000000';

  // ADD VALUE IF NOT EXISTS cannot run inside a transaction on some PG versions.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'NO_SHOW_CLAIM_OPENED'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'NO_SHOW_CLAIM_APPROVED'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'NO_SHOW_CLAIM_REJECTED'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'NO_SHOW_CLAIM_TIMEOUT'
    `);

    await queryRunner.query(`
      CREATE TYPE "public"."no_show_claims_kind_enum" AS ENUM(
        'DRIVER_NO_SHOW',
        'PASSENGER_NO_SHOW'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."no_show_claims_status_enum" AS ENUM(
        'PENDING',
        'APPROVED',
        'REJECTED',
        'SUPERSEDED'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."no_show_claims_decision_source_enum" AS ENUM(
        'RESPONDENT',
        'TIMEOUT'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "no_show_claims" (
        "id" uuid NOT NULL,
        "ride_id" uuid NOT NULL,
        "booking_id" uuid,
        "ride_type" "public"."rides_ride_type_enum" NOT NULL,
        "kind" "public"."no_show_claims_kind_enum" NOT NULL,
        "claimant_user_id" uuid NOT NULL,
        "respondent_user_id" uuid NOT NULL,
        "status" "public"."no_show_claims_status_enum" NOT NULL DEFAULT 'PENDING',
        "respond_by" TIMESTAMP WITH TIME ZONE NOT NULL,
        "responded_at" TIMESTAMP WITH TIME ZONE,
        "responded_by_user_id" uuid,
        "decision_source" "public"."no_show_claims_decision_source_enum",
        "settled_at" TIMESTAMP WITH TIME ZONE,
        "settlement_idempotency_key" character varying(255),
        "support_ticket_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_no_show_claims" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_no_show_claims_passenger_booking"
          CHECK (
            "kind" <> 'PASSENGER_NO_SHOW'
            OR "booking_id" IS NOT NULL
          ),
        CONSTRAINT "FK_no_show_claims_ride_id"
          FOREIGN KEY ("ride_id") REFERENCES "rides"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_no_show_claims_booking_id"
          FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_no_show_claims_claimant_user_id"
          FOREIGN KEY ("claimant_user_id") REFERENCES "users"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_no_show_claims_respondent_user_id"
          FOREIGN KEY ("respondent_user_id") REFERENCES "users"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_no_show_claims_responded_by_user_id"
          FOREIGN KEY ("responded_by_user_id") REFERENCES "users"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_no_show_claims_support_ticket_id"
          FOREIGN KEY ("support_ticket_id") REFERENCES "support_tickets"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_no_show_claims_ride_id"
      ON "no_show_claims" ("ride_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_no_show_claims_booking_id"
      ON "no_show_claims" ("booking_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_no_show_claims_status_respond_by"
      ON "no_show_claims" ("status", "respond_by")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_no_show_claims_pending_driver_ride"
      ON "no_show_claims" ("ride_id")
      WHERE "status" = 'PENDING' AND "kind" = 'DRIVER_NO_SHOW'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_no_show_claims_pending_passenger_booking"
      ON "no_show_claims" ("booking_id")
      WHERE "status" = 'PENDING'
        AND "kind" = 'PASSENGER_NO_SHOW'
        AND "booking_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_no_show_claims_settlement_idempotency_key"
      ON "no_show_claims" ("settlement_idempotency_key")
      WHERE "settlement_idempotency_key" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_no_show_claims_settlement_idempotency_key"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_no_show_claims_pending_passenger_booking"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_no_show_claims_pending_driver_ride"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_no_show_claims_status_respond_by"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_no_show_claims_booking_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_no_show_claims_ride_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "no_show_claims"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."no_show_claims_decision_source_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."no_show_claims_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."no_show_claims_kind_enum"`,
    );
    // Notification enum values are intentionally not removed.
  }
}
