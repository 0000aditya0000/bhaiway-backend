import { DataSource } from 'typeorm';

/**
 * Test-only schema bootstrap matching 1786650000000-AccountDeletionWorkflow.
 * Ensures the test database has the required enum values, tables, and constraints.
 */
export async function applyAccountDeletionSchema(
  dataSource: DataSource,
): Promise<void> {
  // 1. users_status_enum
  await dataSource.query(`
    ALTER TYPE "public"."users_status_enum"
    ADD VALUE IF NOT EXISTS 'DELETION_REQUESTED'
  `);
  await dataSource.query(`
    ALTER TYPE "public"."users_status_enum"
    ADD VALUE IF NOT EXISTS 'DELETION_ACTION_REQUIRED'
  `);
  await dataSource.query(`
    ALTER TYPE "public"."users_status_enum"
    ADD VALUE IF NOT EXISTS 'DELETION_APPROVED'
  `);
  await dataSource.query(`
    ALTER TYPE "public"."users_status_enum"
    ADD VALUE IF NOT EXISTS 'DELETED'
  `);

  // 2. notifications_type_enum
  await dataSource.query(`
    ALTER TYPE "public"."notifications_type_enum"
    ADD VALUE IF NOT EXISTS 'ACCOUNT_DELETION_REQUESTED'
  `);
  await dataSource.query(`
    ALTER TYPE "public"."notifications_type_enum"
    ADD VALUE IF NOT EXISTS 'ACCOUNT_DELETION_ACTION_REQUIRED'
  `);
  await dataSource.query(`
    ALTER TYPE "public"."notifications_type_enum"
    ADD VALUE IF NOT EXISTS 'ACCOUNT_DELETION_APPROVED'
  `);
  await dataSource.query(`
    ALTER TYPE "public"."notifications_type_enum"
    ADD VALUE IF NOT EXISTS 'ACCOUNT_DELETION_CANCELLED'
  `);

  // 3. Request enums
  await dataSource.query(`
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

  await dataSource.query(`
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

  // 4. Audit enums
  await dataSource.query(`
    DO $$ BEGIN
      CREATE TYPE "public"."account_deletion_audit_logs_actor_type_enum" AS ENUM (
        'USER',
        'ADMIN',
        'SYSTEM'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  await dataSource.query(`
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

  // 5. account_deletion_requests table
  await dataSource.query(`
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

  await dataSource.query(`
    CREATE INDEX IF NOT EXISTS "IDX_account_deletion_requests_user_id"
    ON "account_deletion_requests" ("user_id")
  `);
  await dataSource.query(`
    CREATE INDEX IF NOT EXISTS "IDX_account_deletion_requests_status"
    ON "account_deletion_requests" ("status")
  `);
  await dataSource.query(`
    CREATE INDEX IF NOT EXISTS "IDX_account_deletion_requests_created_at"
    ON "account_deletion_requests" ("created_at")
  `);

  await dataSource.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "IDX_account_deletion_requests_active_user"
    ON "account_deletion_requests" ("user_id")
    WHERE "status" IN ('PENDING', 'UNDER_REVIEW', 'ACTION_REQUIRED', 'APPROVED')
  `);

  // 6. account_deletion_audit_logs table
  await dataSource.query(`
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

  await dataSource.query(`
    CREATE INDEX IF NOT EXISTS "IDX_account_deletion_audit_logs_request_id"
    ON "account_deletion_audit_logs" ("request_id")
  `);
  await dataSource.query(`
    CREATE INDEX IF NOT EXISTS "IDX_account_deletion_audit_logs_user_id"
    ON "account_deletion_audit_logs" ("user_id")
  `);
  await dataSource.query(`
    CREATE INDEX IF NOT EXISTS "IDX_account_deletion_audit_logs_created_at"
    ON "account_deletion_audit_logs" ("created_at")
  `);

  // 7. Update users table unique constraints to partial unique indexes for active accounts
  await dataSource.query(`
    ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_a000cca60bcf04454e727699490"
  `);
  await dataSource.query(`
    ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_97672ac88f789774dd47f7c8be3"
  `);
  await dataSource.query(`
    ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_phone_key"
  `);
  await dataSource.query(`
    ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_key"
  `);
  await dataSource.query(`
    ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_users_phone"
  `);
  await dataSource.query(`
    ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_users_email"
  `);
  await dataSource.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_phone_active"
    ON "users" ("phone")
    WHERE "status" != 'DELETED'
  `);
  await dataSource.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_email_active"
    ON "users" ("email")
    WHERE "status" != 'DELETED' AND "email" IS NOT NULL
  `);
}
