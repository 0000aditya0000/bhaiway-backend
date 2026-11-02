import { MigrationInterface, QueryRunner } from 'typeorm';

export class AccountDeletionWorkflow1786650000000 implements MigrationInterface {
  name = 'AccountDeletionWorkflow1786650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Extend users_status_enum
    await queryRunner.query(`
      ALTER TYPE "public"."users_status_enum"
      ADD VALUE IF NOT EXISTS 'DELETION_REQUESTED'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."users_status_enum"
      ADD VALUE IF NOT EXISTS 'DELETION_ACTION_REQUIRED'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."users_status_enum"
      ADD VALUE IF NOT EXISTS 'DELETION_APPROVED'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."users_status_enum"
      ADD VALUE IF NOT EXISTS 'DELETED'
    `);

    // 2. Extend notifications_type_enum
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'ACCOUNT_DELETION_REQUESTED'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'ACCOUNT_DELETION_ACTION_REQUIRED'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'ACCOUNT_DELETION_APPROVED'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."notifications_type_enum"
      ADD VALUE IF NOT EXISTS 'ACCOUNT_DELETION_CANCELLED'
    `);

    // 3. Create request reason and status enums
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."account_deletion_requests_reason_enum" AS ENUM (
          'NO_LONGER_USING',
          'PRIVACY_CONCERNS',
          'POOR_USER_EXPERIENCE',
          'SWITCHED_TO_ANOTHER_SERVICE',
          'ACCOUNT_OR_TECHNICAL_ISSUES',
          'OTHER'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."account_deletion_requests_status_enum" AS ENUM (
          'PENDING',
          'UNDER_REVIEW',
          'ACTION_REQUIRED',
          'APPROVED',
          'COMPLETED',
          'CANCELLED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // 4. Create audit enums
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."account_deletion_audit_logs_actor_type_enum" AS ENUM (
          'USER',
          'ADMIN',
          'SYSTEM'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."account_deletion_audit_logs_action_enum" AS ENUM (
          'REQUEST_SUBMITTED',
          'REVIEW_STARTED',
          'USER_ACTION_REQUESTED',
          'REQUEST_APPROVED',
          'REQUEST_CANCELLED',
          'DELETION_COMPLETED',
          'DELETION_FAILED',
          'COMPLETION_BLOCKED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // 5. Create account_deletion_requests table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "account_deletion_requests" (
        "id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "reason" "public"."account_deletion_requests_reason_enum" NOT NULL,
        "additional_comment" text,
        "status" "public"."account_deletion_requests_status_enum" NOT NULL DEFAULT 'PENDING',
        "requested_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "reviewed_at" TIMESTAMP WITH TIME ZONE,
        "response_due_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "admin_id" uuid,
        "admin_note" text,
        "user_action_required" boolean NOT NULL DEFAULT false,
        "user_action_message" text,
        "approved_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "cancelled_at" TIMESTAMP WITH TIME ZONE,
        "cancellation_reason" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_account_deletion_requests_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_account_deletion_requests_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_account_deletion_requests_user_id"
      ON "account_deletion_requests" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_account_deletion_requests_status"
      ON "account_deletion_requests" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_account_deletion_requests_created_at"
      ON "account_deletion_requests" ("created_at")
    `);

    // Partial unique index enforcing at most one active deletion request per user
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_account_deletion_requests_active_user"
      ON "account_deletion_requests" ("user_id")
      WHERE "status" IN ('PENDING', 'UNDER_REVIEW', 'ACTION_REQUIRED', 'APPROVED')
    `);

    // 6. Create account_deletion_audit_logs table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "account_deletion_audit_logs" (
        "id" uuid NOT NULL,
        "request_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "actor_type" "public"."account_deletion_audit_logs_actor_type_enum" NOT NULL,
        "actor_id" uuid,
        "action" "public"."account_deletion_audit_logs_action_enum" NOT NULL,
        "reason" text,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_account_deletion_audit_logs_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_account_deletion_audit_logs_request_id"
      ON "account_deletion_audit_logs" ("request_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_account_deletion_audit_logs_user_id"
      ON "account_deletion_audit_logs" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_account_deletion_audit_logs_created_at"
      ON "account_deletion_audit_logs" ("created_at")
    `);

    // 7. Scoped unique indexes on users: allow retained DELETED user records
    // to preserve original phone & email while permitting new registration of that phone
    await queryRunner.query(`
      ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_a000cca60bcf04454e727699490"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_97672ac88f789774dd47f7c8be3"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_users_phone"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_users_email"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_phone_active"
      ON "users" ("phone")
      WHERE "status" != 'DELETED'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_email_active"
      ON "users" ("email")
      WHERE "status" != 'DELETED' AND "email" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_users_email_active"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_users_phone_active"`);
    await queryRunner.query(`
      ALTER TABLE "users" ADD CONSTRAINT "UQ_a000cca60bcf04454e727699490" UNIQUE ("phone")
    `);
    await queryRunner.query(`
      ALTER TABLE "users" ADD CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email")
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_account_deletion_audit_logs_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_account_deletion_audit_logs_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_account_deletion_audit_logs_request_id"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "account_deletion_audit_logs"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_account_deletion_requests_active_user"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_account_deletion_requests_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_account_deletion_requests_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_account_deletion_requests_user_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "account_deletion_requests"`);

    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."account_deletion_audit_logs_action_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."account_deletion_audit_logs_actor_type_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."account_deletion_requests_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."account_deletion_requests_reason_enum"`,
    );
  }
}
