import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admin ride directory/cancel: cancellation reasons, ops notification type,
 * Assured queue advance reason, and structured admin_ride_cancellations audit.
 */
export class AdminRideManagement1786600000000 implements MigrationInterface {
  name = 'AdminRideManagement1786600000000';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."rides_cancellation_reason_enum"
      ADD VALUE IF NOT EXISTS 'ADMIN_CANCELLED'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."bookings_cancellation_reason_enum"
      ADD VALUE IF NOT EXISTS 'ADMIN_CANCELLED'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'ADMIN_RIDE_CANCELLED'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."assured_queue_events_advance_reason_enum"
      ADD VALUE IF NOT EXISTS 'ADMIN_CANCELLED'
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin_ride_cancellations" (
        "id" uuid NOT NULL,
        "admin_user_id" uuid NOT NULL,
        "admin_actor_user_id" uuid NOT NULL,
        "ride_id" uuid NOT NULL,
        "ride_type" character varying(32) NOT NULL,
        "previous_status" character varying(32) NOT NULL,
        "final_status" character varying(32) NOT NULL,
        "reason" character varying(500) NOT NULL,
        "series_scope" character varying(32),
        "support_escalation_required" boolean NOT NULL DEFAULT false,
        "refund_total" bigint NOT NULL DEFAULT 0,
        "deposit_release_total" bigint NOT NULL DEFAULT 0,
        "compensation_total" bigint NOT NULL DEFAULT 0,
        "already_applied" boolean NOT NULL DEFAULT false,
        "bookings" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "financial_transaction_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "idempotency_key" character varying(255) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_admin_ride_cancellations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_admin_ride_cancellations_idempotency_key" UNIQUE ("idempotency_key"),
        CONSTRAINT "FK_admin_ride_cancellations_admin_user_id"
          FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_admin_ride_cancellations_ride_id"
          FOREIGN KEY ("ride_id") REFERENCES "rides"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_admin_ride_cancellations_ride_id"
      ON "admin_ride_cancellations" ("ride_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_admin_ride_cancellations_admin_user_id"
      ON "admin_ride_cancellations" ("admin_user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_admin_ride_cancellations_created_at"
      ON "admin_ride_cancellations" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_admin_ride_cancellations_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_admin_ride_cancellations_admin_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_admin_ride_cancellations_ride_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "admin_ride_cancellations"`);
  }
}
